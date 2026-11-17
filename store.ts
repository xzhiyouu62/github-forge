// The forge's in-memory state: one viewer (the token's login), repositories with their git refs,
// issues and pull requests sharing one number sequence per repo, labels and comments.

import { ObjectStore } from './gitobj.ts';

/** The token's identity, fixed by the contest's wire contract (the suite drives this login). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  pullRequest?: Pull; // set when this number is a pull request
}

export interface Pull {
  number: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  draft: boolean;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>; // 'refs/heads/main' -> commit sha; tags under 'refs/tags/'
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextNumber: number; // issues and pulls share this counter, as on GitHub
}

export class Forge {
  readonly store = new ObjectStore();
  readonly repos = new Map<string, Repo>(); // key: owner/name
  #nextRepoId = 1;
  #nextLabelId = 1;
  #nextIssueId = 1;
  #nextCommentId = 1;

  nowIso(): string {
    return new Date().toISOString();
  }

  createRepo(name: string, description: string | null, isPrivate: boolean, defaultBranch: string): Repo {
    const ts = this.nowIso();
    const repo: Repo = {
      id: this.#nextRepoId,
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch,
      createdAt: ts,
      updatedAt: ts,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextNumber: 1,
    };
    this.#nextRepoId += 1;
    this.repos.set(`${repo.owner}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined; // another owner's namespace is a 404 for this token
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(`${repo.owner}/${repo.name}`);
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login);
  }

  createLabel(repo: Repo, name: string, color: string, description: string | null): Label {
    const label: Label = { id: this.#nextLabelId, name, color, description };
    this.#nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string | null, labels: string[]): Issue {
    const ts = this.nowIso();
    const issue: Issue = {
      id: this.#nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin: VIEWER.login,
      comments: [],
      createdAt: ts,
      updatedAt: ts,
    };
    this.#nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const ts = this.nowIso();
    const comment: Comment = { id: this.#nextCommentId, body, userLogin: VIEWER.login, createdAt: ts, updatedAt: ts };
    this.#nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedAt = ts;
    return comment;
  }
}
