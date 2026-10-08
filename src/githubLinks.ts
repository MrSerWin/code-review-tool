/** GitHub pages for a reviewed branch, so a reader can jump from a review to the code. */
export interface GithubLinks {
  repo: string;
  branch: string;
  /** The pull request, when the run knows its number. */
  pr: string | null;
  /** The branch's changes against its base, as GitHub shows them. */
  compare: string | null;
  head: string | null;
  base: string | null;
}

interface LinkSource {
  repo: string;
  branch: string;
  base_branch: string | null;
  pr_number: number | null;
  head_sha: string | null;
  base_sha: string | null;
}

/** Encode each path segment but keep the slashes branch names are made of. */
function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function repoPageUrl(org: string, repo: string): string {
  return `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
}

/** The GitHub page of one branch. */
export function branchUrl(org: string, repo: string, branch: string): string {
  return `${repoPageUrl(org, repo)}/tree/${refPath(branch)}`;
}

export function githubLinks(org: string, review: LinkSource): GithubLinks {
  const repoUrl = repoPageUrl(org, review.repo);
  const branch = refPath(review.branch);
  return {
    repo: repoUrl,
    branch: branchUrl(org, review.repo, review.branch),
    pr: review.pr_number ? `${repoUrl}/pull/${review.pr_number}` : null,
    compare: review.base_branch ? `${repoUrl}/compare/${refPath(review.base_branch)}...${branch}` : null,
    head: review.head_sha ? `${repoUrl}/commit/${review.head_sha}` : null,
    base: review.base_sha ? `${repoUrl}/commit/${review.base_sha}` : null,
  };
}
