// GraphQL v4 surface: POST /api/graphql. A small hand-rolled parser and
// executor for the fixed documents gh and github-mcp-server actually send
// (viewer, repository fields, __type probes, issue/PR reads, the five
// mutations, node(), cursor pagination, and batched operations). No schema
// library; unknown fields answer HTTP 200 with a non-empty errors array
// whose message names the field.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StoreError, VIEWER_LOGIN, type IssueRec, type PrRec, type RepoRec } from './store.ts';
import {
  createPr,
  mergePr,
  prFiles,
  prMergeable,
  resolveIssueByNodeId,
  resolvePrByNodeId,
  resolveRepoByNodeId,
  type ForgeContext,
} from './service.ts';

// ------------------------------------------------------------ tokenizer

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text.replace(/\\"/g, '"') });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: FieldNode[];
  fragmentType: string | null;
  fragmentSpread: string | null;
}

interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  varDefs: Map<string, ValueNode | null>;
  selections: FieldNode[];
}

class Parser {
  tokens: Token[];
  pos = 0;
  fragments: Map<string, { type: string; selections: FieldNode[] }> = new Map();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return tok;
  }

  expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && tok.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return tok.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const tok = this.peek() as Token;
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        this.expectName('on');
        const type = this.expectName();
        const selections = this.parseSelectionSet();
        this.fragments.set(fragName, { type, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    let opType: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const tok = this.peek() as Token;
    if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      opType = tok.value;
      this.next();
      const nextTok = this.peek();
      if (nextTok !== undefined && nextTok.kind === 'name') name = this.next().value;
    }
    const varDefs = new Map<string, ValueNode | null>();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseTypeName();
        let defaultValue: ValueNode | null = null;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        varDefs.set(varName, defaultValue);
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { opType, name, varDefs, selections };
  }

  parseTypeName(): void {
    const tok = this.peek();
    if (tok?.kind === 'punct' && tok.value === '[') {
      this.next();
      this.parseTypeName();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  parseField(): FieldNode {
    const tok = this.peek() as Token;
    if (tok.kind === 'spread') {
      this.next();
      const nextTok = this.peek();
      if (nextTok !== undefined && nextTok.kind === 'name' && nextTok.value === 'on') {
        this.next();
        const type = this.expectName();
        const selections = this.parseSelectionSet();
        return { alias: null, name: '__fragment', args: [], selections, fragmentType: type, fragmentSpread: null };
      }
      const fragName = this.expectName();
      return { alias: null, name: '__fragment', args: [], selections: [], fragmentType: null, fragmentSpread: fragName };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Skip directives such as @include(if: ...).
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selections: FieldNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections, fragmentType: null, fragmentSpread: null };
  }

  parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number(tok.value) };
    if (tok.kind === 'float') return { kind: 'float', value: Number(tok.value) };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${tok.value} in GraphQL document`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      return variables[node.name] ?? null;
    }
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function argString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function argInt(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// ------------------------------------------------------------ schema knowledge

const USER_FIELDS = new Set(['login', 'id', 'name', 'email', 'type', 'url', 'html_url', 'avatar_url', 'createdAt', 'updatedAt']);
const REPO_FIELDS = new Set([
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
  'createdAt', 'updatedAt', 'url', 'fullName',
]);
const ISSUE_FIELDS = new Set(['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'labels', 'comments', 'repository']);
const PR_FIELDS = new Set([
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
  'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'url', 'author',
]);
const REF_FIELDS = new Set(['name', 'prefix', 'target']);
const ISSUE_CONN_FIELDS = new Set(['nodes', 'pageInfo', 'totalCount', 'edges']);
const PR_CONN_FIELDS = new Set(['nodes', 'pageInfo', 'totalCount', 'edges']);
const FILE_CONN_FIELDS = new Set(['nodes', 'pageInfo', 'totalCount', 'edges']);
const FILE_FIELDS = new Set(['path', 'filename', 'additions', 'deletions', 'changes']);
const PAGE_INFO_FIELDS = new Set(['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor']);
const TYPE_FIELDS = new Set(['name', 'kind', 'fields', 'enumValues', 'description']);
const FIELD_FIELDS = new Set(['name', 'description', 'type']);
const ENUM_VALUE_FIELDS = new Set(['name', 'description']);
const COMMENT_EDGE_FIELDS = new Set(['node', 'cursor']);
const COMMENT_FIELDS = new Set(['id', 'body', 'createdAt', 'author', 'url']);

const TYPE_FIELD_NAMES: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'comments', 'labels', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'url', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function fieldsFor(typeName: string): string[] {
  return TYPE_FIELD_NAMES[typeName] ?? [];
}

// ------------------------------------------------------------ node values

type NodeValue =
  | { kind: 'User' }
  | { kind: 'Repository'; repo: RepoRec }
  | { kind: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { kind: 'PullRequest'; repo: RepoRec; pr: PrRec }
  | { kind: 'IssueConnection'; repo: RepoRec; issues: IssueRec[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { kind: 'PullRequestConnection'; repo: RepoRec; prs: PrRec[] }
  | { kind: 'FileConnection'; repo: RepoRec; pr: PrRec; files: { path: string; additions: number; deletions: number; changes: number }[] }
  | { kind: 'Ref'; name: string }
  | { kind: 'Type'; typeName: string }
  | { kind: 'TypeField'; name: string }
  | { kind: 'EnumValue'; name: string }
  | { kind: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'CommentEdge'; comment: { id: string; body: string } }
  | { kind: 'Comment'; comment: { id: string; body: string } }
  | { kind: 'IssuePayload'; repo: RepoRec; issue: IssueRec }
  | { kind: 'PullRequestPayload'; repo: RepoRec; pr: PrRec }
  | { kind: 'CommentPayload'; comment: { id: string; body: string } };

function typeNameOf(node: NodeValue): string {
  switch (node.kind) {
    case 'User': return 'User';
    case 'Repository': return 'Repository';
    case 'Issue': return 'Issue';
    case 'PullRequest': return 'PullRequest';
    case 'IssueConnection': return 'IssueConnection';
    case 'PullRequestConnection': return 'PullRequestConnection';
    case 'FileConnection': return 'PullRequestChangedFileConnection';
    case 'Ref': return 'Ref';
    case 'Type': return '__Type';
    case 'TypeField': return '__Field';
    case 'EnumValue': return '__EnumValue';
    case 'PageInfo': return 'PageInfo';
    case 'CommentEdge': return 'IssueCommentEdge';
    case 'Comment': return 'IssueComment';
    case 'IssuePayload': return 'CreateIssuePayload';
    case 'PullRequestPayload': return 'CreatePullRequestPayload';
    case 'CommentPayload': return 'AddCommentPayload';
  }
}

function fieldSetFor(typeName: string): Set<string> | null {
  switch (typeName) {
    case 'User': return USER_FIELDS;
    case 'Repository': return REPO_FIELDS;
    case 'Issue': return ISSUE_FIELDS;
    case 'PullRequest': return PR_FIELDS;
    case 'Ref': return REF_FIELDS;
    case 'IssueConnection': return ISSUE_CONN_FIELDS;
    case 'PullRequestConnection': return PR_CONN_FIELDS;
    case 'PullRequestChangedFileConnection': return FILE_CONN_FIELDS;
    case 'PullRequestChangedFile': return FILE_FIELDS;
    case 'PageInfo': return PAGE_INFO_FIELDS;
    case '__Type': return TYPE_FIELDS;
    case '__Field': return FIELD_FIELDS;
    case '__EnumValue': return ENUM_VALUE_FIELDS;
    case 'IssueCommentEdge': return COMMENT_EDGE_FIELDS;
    case 'IssueComment': return COMMENT_FIELDS;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': return new Set(['issue', 'clientMutationId']);
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': return new Set(['pullRequest', 'clientMutationId']);
    case 'AddCommentPayload': return new Set(['commentEdge', 'clientMutationId']);
    default: return null;
  }
}

function issueStateGql(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function prStateGql(pr: PrRec): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function numberFromCursor(cursor: string | null): number | null {
  if (cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m !== null ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ executor

interface ExecState {
  ctx: ForgeContext;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, { type: string; selections: FieldNode[] }>;
}

function executeSelections(
  state: ExecState,
  node: NodeValue,
  selections: FieldNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = typeNameOf(node);
  const allowed = fieldSetFor(typeName);
  for (const field of selections) {
    if (field.name === '__fragment') {
      if (field.fragmentSpread !== null) {
        const frag = state.fragments.get(field.fragmentSpread);
        if (frag !== undefined && (frag.type === typeName || frag.type === 'Node')) {
          Object.assign(out, executeSelections(state, node, frag.selections));
        }
        continue;
      }
      if (field.fragmentType !== null && (field.fragmentType === typeName || field.fragmentType === 'Node')) {
        Object.assign(out, executeSelections(state, node, field.selections));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (allowed !== null && !allowed.has(field.name)) {
      state.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    try {
      out[key] = resolveField(state, node, field);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.errors.push({ message });
      out[key] = null;
    }
  }
  return out;
}

function resolveField(state: ExecState, node: NodeValue, field: FieldNode): unknown {
  const ctx = state.ctx;
  const args = argsOf(field, state.variables);
  const sel = field.selections;

  switch (node.kind) {
    case 'User': {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (field.name === 'id') return 'U_1000';
      if (field.name === 'name') return 'Ada Iversen';
      if (field.name === 'email') return 'adaiversen@example.invalid';
      if (field.name === 'type') return 'User';
      if (field.name === 'url' || field.name === 'html_url') return `https://example.invalid/${VIEWER_LOGIN}`;
      if (field.name === 'avatar_url') return '';
      if (field.name === 'createdAt' || field.name === 'updatedAt') return ctx.clock.nowIso();
      return null;
    }
    case 'Repository': {
      const repo = node.repo;
      switch (field.name) {
        case 'id': return repo.nodeId;
        case 'databaseId': return repo.databaseId;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.full_name;
        case 'fullName': return repo.full_name;
        case 'description': return repo.description;
        case 'private': return repo.private;
        case 'createdAt': return repo.created_at;
        case 'updatedAt': return repo.updated_at;
        case 'url': return `/api/v3/repos/${repo.full_name}`;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'owner': return executeSelections(state, { kind: 'User' }, sel);
        case 'defaultBranchRef': {
          const tip = ctx.git.getBranchTip(repo.owner, repo.name, repo.default_branch);
          if (tip === null) return null;
          return executeSelections(state, { kind: 'Ref', name: repo.default_branch }, sel);
        }
        case 'issue': {
          const number = argInt(args, 'number');
          if (number === null) return null;
          const issue = repo.issues.get(number);
          if (issue === undefined) return null;
          return executeSelections(state, { kind: 'Issue', repo, issue }, sel);
        }
        case 'issues': return executeSelections(state, { kind: 'IssueConnection', repo, ...issuesConnection(ctx, repo, args) }, sel);
        case 'pullRequests': {
          const first = argInt(args, 'first');
          let prs = [...repo.prs.values()].sort((a, b) => a.createdSeq - b.createdSeq);
          if (first !== null) prs = prs.slice(0, first);
          return executeSelections(state, { kind: 'PullRequestConnection', repo, prs }, sel);
        }
        case 'pullRequest': {
          const number = argInt(args, 'number');
          if (number === null) return null;
          const pr = repo.prs.get(number);
          if (pr === undefined) return null;
          return executeSelections(state, { kind: 'PullRequest', repo, pr }, sel);
        }
        default: return null;
      }
    }
    case 'Issue': {
      const { issue } = node;
      switch (field.name) {
        case 'id': return issue.nodeId;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueStateGql(issue.state);
        case 'createdAt': return issue.created_at;
        case 'updatedAt': return issue.updated_at;
        case 'url': return `/api/v3/repos/${node.repo.full_name}/issues/${issue.number}`;
        case 'author': return executeSelections(state, { kind: 'User' }, sel);
        case 'repository': return executeSelections(state, { kind: 'Repository', repo: node.repo }, sel);
        case 'labels': return issue.labels.map((name) => ({ name }));
        case 'comments': return issue.comments.map((c) => executeSelections(state, { kind: 'Comment', comment: { id: c.nodeId, body: c.body } }, sel));
        default: return null;
      }
    }
    case 'PullRequest': {
      const { pr } = node;
      switch (field.name) {
        case 'id': return pr.nodeId;
        case 'number': return pr.number;
        case 'title': return pr.title;
        case 'body': return pr.body;
        case 'state': return prStateGql(pr);
        case 'merged': return pr.merged;
        case 'mergeable': return prMergeable(ctx, node.repo, pr);
        case 'headRefName': return pr.headRef;
        case 'baseRefName': return pr.baseRef;
        case 'headRef': return executeSelections(state, { kind: 'Ref', name: pr.headRef }, sel);
        case 'baseRef': return executeSelections(state, { kind: 'Ref', name: pr.baseRef }, sel);
        case 'createdAt': return pr.created_at;
        case 'updatedAt': return pr.updated_at;
        case 'url': return `/api/v3/repos/${node.repo.full_name}/pulls/${pr.number}`;
        case 'author': return executeSelections(state, { kind: 'User' }, sel);
        case 'files': {
          const first = argInt(args, 'first');
          const computed = prFiles(ctx, node.repo, pr).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes }));
          const files = first !== null ? computed.slice(0, first) : computed;
          return executeSelections(state, { kind: 'FileConnection', repo: node.repo, pr, files }, sel);
        }
        default: return null;
      }
    }
    case 'IssueConnection': {
      switch (field.name) {
        case 'nodes': return node.issues.map((issue) => executeSelections(state, { kind: 'Issue', repo: node.repo, issue }, sel));
        case 'totalCount': return node.issues.length;
        case 'pageInfo': return executeSelections(state, { kind: 'PageInfo', hasNextPage: node.pageInfo.hasNextPage, endCursor: node.pageInfo.endCursor }, sel);
        case 'edges': return node.issues.map((issue) => ({ node: executeSelections(state, { kind: 'Issue', repo: node.repo, issue }, sel), cursor: cursorFor(issue.number) }));
        default: return null;
      }
    }
    case 'PullRequestConnection': {
      switch (field.name) {
        case 'nodes': return node.prs.map((pr) => executeSelections(state, { kind: 'PullRequest', repo: node.repo, pr }, sel));
        case 'totalCount': return node.prs.length;
        case 'pageInfo': return executeSelections(state, { kind: 'PageInfo', hasNextPage: false, endCursor: null }, sel);
        case 'edges': return node.prs.map((pr) => ({ node: executeSelections(state, { kind: 'PullRequest', repo: node.repo, pr }, sel), cursor: cursorFor(pr.number) }));
        default: return null;
      }
    }
    case 'FileConnection': {
      switch (field.name) {
        case 'nodes': return node.files.map((f) => fileNode(state, f, sel));
        case 'totalCount': return node.files.length;
        case 'pageInfo': return executeSelections(state, { kind: 'PageInfo', hasNextPage: false, endCursor: null }, sel);
        case 'edges': return node.files.map((f) => ({ node: fileNode(state, f, sel), cursor: cursorFor(1) }));
        default: return null;
      }
    }
    case 'Ref': {
      if (field.name === 'name') return node.name;
      if (field.name === 'prefix') return 'refs/heads/';
      if (field.name === 'target') return null;
      return null;
    }
    case 'Type': {
      const typeName = node.typeName;
      switch (field.name) {
        case 'name': return typeName;
        case 'kind': return TYPE_ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT';
        case 'description': return null;
        case 'fields': {
          const names = fieldsFor(typeName);
          return names.map((name) => executeSelections(state, { kind: 'TypeField', name }, sel));
        }
        case 'enumValues': {
          const values = TYPE_ENUM_VALUES[typeName] ?? [];
          return values.map((name) => executeSelections(state, { kind: 'EnumValue', name }, sel));
        }
        default: return null;
      }
    }
    case 'TypeField': {
      if (field.name === 'name') return node.name;
      if (field.name === 'description') return null;
      if (field.name === 'type') return null;
      return null;
    }
    case 'EnumValue': {
      if (field.name === 'name') return node.name;
      if (field.name === 'description') return null;
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return node.hasNextPage;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'endCursor') return node.endCursor;
      if (field.name === 'startCursor') return null;
      return null;
    }
    case 'CommentEdge': {
      if (field.name === 'node') return executeSelections(state, { kind: 'Comment', comment: node.comment }, sel);
      if (field.name === 'cursor') return node.comment.id;
      return null;
    }
    case 'Comment': {
      if (field.name === 'id') return node.comment.id;
      if (field.name === 'body') return node.comment.body;
      if (field.name === 'createdAt') return ctx.clock.nowIso();
      if (field.name === 'author') return executeSelections(state, { kind: 'User' }, sel);
      if (field.name === 'url') return '';
      return null;
    }
    case 'IssuePayload': {
      if (field.name === 'issue') return executeSelections(state, { kind: 'Issue', repo: node.repo, issue: node.issue }, sel);
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    case 'PullRequestPayload': {
      if (field.name === 'pullRequest') return executeSelections(state, { kind: 'PullRequest', repo: node.repo, pr: node.pr }, sel);
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    case 'CommentPayload': {
      if (field.name === 'commentEdge') return executeSelections(state, { kind: 'CommentEdge', comment: node.comment }, sel);
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    default:
      return null;
  }
}

function fileNode(
  state: ExecState,
  f: { path: string; additions: number; deletions: number; changes: number },
  sel: FieldNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of sel) {
    const key = field.alias ?? field.name;
    if (field.name === 'path') out[key] = f.path;
    else if (field.name === 'filename') out[key] = f.path;
    else if (field.name === 'additions') out[key] = f.additions;
    else if (field.name === 'deletions') out[key] = f.deletions;
    else if (field.name === 'changes') out[key] = f.changes;
    else {
      state.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequestChangedFile".` });
      out[key] = null;
    }
  }
  return out;
}

function issuesConnection(
  ctx: ForgeContext,
  repo: RepoRec,
  args: Record<string, unknown>,
): { issues: IssueRec[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issueStateGql(issue.state)));
  }
  const orderBy = args.orderBy;
  let direction = 'ASC';
  if (orderBy !== null && typeof orderBy === 'object') {
    const dir = (orderBy as Record<string, unknown>).direction;
    if (typeof dir === 'string') direction = dir.toUpperCase();
  }
  issues.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  const after = typeof args.after === 'string' ? args.after : null;
  let start = 0;
  if (after !== null) {
    const cursorNumber = numberFromCursor(after);
    if (cursorNumber !== null) {
      const idx = issues.findIndex((issue) => issue.number === cursorNumber);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = argInt(args, 'first');
  const slice = first !== null ? issues.slice(start, start + first) : issues.slice(start);
  const hasNextPage = start + slice.length < issues.length;
  const endCursor = slice.length > 0 ? cursorFor((slice[slice.length - 1] as IssueRec).number) : null;
  return { issues: slice, pageInfo: { hasNextPage, endCursor } };
}

// ------------------------------------------------------------ root operations

const QUERY_FIELDS = new Set(['viewer', 'repository', 'node', '__type', '__schema']);
const MUTATION_FIELDS = new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']);

function executeOperation(
  ctx: ForgeContext,
  op: Operation,
  variables: Record<string, unknown>,
  fragments: Map<string, { type: string; selections: FieldNode[] }>,
): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const state: ExecState = { ctx, variables, errors: [], fragments };
  const data: Record<string, unknown> = {};
  const allowed = op.opType === 'query' ? QUERY_FIELDS : MUTATION_FIELDS;
  for (const field of op.selections) {
    const key = field.alias ?? field.name;
    if (!allowed.has(field.name)) {
      state.errors.push({ message: `Cannot query field "${field.name}" on type "${op.opType === 'query' ? 'Query' : 'Mutation'}".` });
      data[key] = null;
      continue;
    }
    try {
      data[key] = executeRoot(state, op.opType, field);
    } catch (err) {
      state.errors.push({ message: err instanceof Error ? err.message : String(err) });
      data[key] = null;
    }
  }
  const out: { data: Record<string, unknown>; errors?: { message: string }[] } = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

function executeRoot(state: ExecState, opType: string, field: FieldNode): unknown {
  const ctx = state.ctx;
  const args = argsOf(field, state.variables);
  const sel = field.selections;
  if (opType === 'query') {
    switch (field.name) {
      case 'viewer':
        return executeSelections(state, { kind: 'User' }, sel);
      case 'repository': {
        const owner = argString(args, 'owner');
        const name = argString(args, 'name');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = ctx.store.getRepo(owner, name);
        if (repo === null) return null;
        return executeSelections(state, { kind: 'Repository', repo }, sel);
      }
      case 'node': {
        const id = argString(args, 'id');
        const repoHit = resolveRepoByNodeId(ctx, id);
        if (repoHit !== null) return executeSelections(state, { kind: 'Repository', repo: repoHit }, sel);
        const issueHit = resolveIssueByNodeId(ctx, id);
        if (issueHit !== null) return executeSelections(state, { kind: 'Issue', repo: issueHit.repo, issue: issueHit.issue }, sel);
        const prHit = resolvePrByNodeId(ctx, id);
        if (prHit !== null) return executeSelections(state, { kind: 'PullRequest', repo: prHit.repo, pr: prHit.pr }, sel);
        return null;
      }
      case '__type': {
        const typeName = argString(args, 'name');
        if (TYPE_FIELD_NAMES[typeName] === undefined && TYPE_ENUM_VALUES[typeName] === undefined) return null;
        return executeSelections(state, { kind: 'Type', typeName }, sel);
      }
      case '__schema':
        return null;
      default:
        return null;
    }
  }
  // Mutations.
  const input = (args.input !== null && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const repo = resolveRepoByNodeId(ctx, repositoryId);
      if (repo === null) throw new Error(`repository ${repositoryId} not found`);
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.store.createIssue(repo, title, body, []);
      return executeSelections(state, { kind: 'IssuePayload', repo, issue }, sel);
    }
    case 'closeIssue': {
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const hit = resolveIssueByNodeId(ctx, issueId);
      if (hit === null) throw new Error(`issue ${issueId} not found`);
      ctx.store.setIssueState(hit.repo, hit.issue, 'closed');
      return executeSelections(state, { kind: 'IssuePayload', repo: hit.repo, issue: hit.issue }, sel);
    }
    case 'createPullRequest': {
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const repo = resolveRepoByNodeId(ctx, repositoryId);
      if (repo === null) throw new Error(`repository ${repositoryId} not found`);
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const pr = createPr(ctx, repo, title, body, headRefName, baseRefName);
      return executeSelections(state, { kind: 'PullRequestPayload', repo, pr }, sel);
    }
    case 'mergePullRequest': {
      const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const hit = resolvePrByNodeId(ctx, pullRequestId);
      if (hit === null) throw new Error(`pull request ${pullRequestId} not found`);
      mergePr(ctx, hit.repo, hit.pr);
      return executeSelections(state, { kind: 'PullRequestPayload', repo: hit.repo, pr: hit.pr }, sel);
    }
    case 'addComment': {
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const hit = resolveIssueByNodeId(ctx, subjectId);
      if (hit === null) throw new Error(`subject ${subjectId} not found`);
      const comment = ctx.store.addComment(hit.repo, hit.issue, body);
      return executeSelections(state, { kind: 'CommentPayload', comment: { id: comment.nodeId, body: comment.body } }, sel);
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------ HTTP entry

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function handleGraphql(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ForgeContext,
  rawBody: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { message: 'request body is not valid JSON' });
    return;
  }
  const ops = Array.isArray(parsed) ? parsed : [parsed];
  const results: unknown[] = [];
  for (const op of ops) {
    results.push(executeOne(ctx, op));
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
}

function executeOne(ctx: ForgeContext, op: unknown): Record<string, unknown> {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    return { data: null, errors: [{ message: 'a GraphQL operation must be an object with a query string' }] };
  }
  const record = op as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
    ? record.variables
    : {}) as Record<string, unknown>;
  let operations: Operation[];
  let fragments: Map<string, { type: string; selections: FieldNode[] }>;
  try {
    const parser = new Parser(tokenize(query));
    operations = parser.parseDocument();
    fragments = parser.fragments;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'could not parse the query' }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'the document holds no operation' }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let operation = operations[0] as Operation;
  if (operationName !== null) {
    const named = operations.find((o) => o.name === operationName);
    if (named === undefined) {
      return { data: null, errors: [{ message: `unknown operation ${operationName}` }] };
    }
    operation = named;
  }
  // Apply variable defaults.
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, defaultValue] of operation.varDefs) {
    if (vars[name] === undefined && defaultValue !== null) vars[name] = resolveValue(defaultValue, {});
  }
  try {
    return executeOperation(ctx, operation, vars, fragments);
  } catch (err) {
    if (err instanceof StoreError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'execution failed' }] };
  }
}
