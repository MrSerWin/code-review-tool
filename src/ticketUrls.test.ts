import './testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { rowLinks } from './githubLinks.js';
import { parsePullRequestRef } from './resolver.js';
import { ticketInputFromUrl, ticketRefFromUrl } from './trackers/urls.js';

const ref = (tracker: string, key: string) => ({ tracker, key });

test('Linear issue links name their key', () => {
  for (const url of [
    'https://linear.app/acme/issue/ABC-123',
    'https://linear.app/acme/issue/ABC-123/add-export-to-the-report',
    'https://linear.app/acme/issue/abc-123/add-export?foo=1#comment-9',
    'http://www.linear.app/acme/issue/ABC-123/',
    '<https://linear.app/acme/issue/ABC-123/add-export>',
    '  linear.app/acme/issue/ABC-123  ',
  ]) {
    assert.deepEqual(ticketRefFromUrl(url), ref('linear', 'ABC-123'), url);
  }
  assert.equal(ticketInputFromUrl('https://linear.app/acme/issue/ABC-123/x'), 'linear:ABC-123');
});

test('Jira issue links: browse, board selectedIssue, and issues paths', () => {
  for (const url of [
    'https://acme.atlassian.net/browse/ABC-123',
    'https://acme.atlassian.net/browse/abc-123/',
    'https://acme.atlassian.net/browse/ABC-123?focusedCommentId=1#comment-1',
    'https://acme.atlassian.net/jira/software/projects/ABC/boards/7?selectedIssue=ABC-123',
    'https://acme.atlassian.net/jira/software/c/projects/ABC/boards/7/backlog?selectedIssue=ABC-123&text=x',
    'https://acme.atlassian.net/jira/software/c/projects/ABC/issues/ABC-123',
    'http://www.acme.atlassian.net/browse/ABC-123',
  ]) {
    assert.deepEqual(ticketRefFromUrl(url), ref('jira', 'ABC-123'), url);
  }
  // A Jira site on its own domain counts once it is the configured one.
  const hosts = { jira: 'https://jira.example.com/' };
  assert.deepEqual(ticketRefFromUrl('https://jira.example.com/browse/ABC-1', hosts), ref('jira', 'ABC-1'));
  assert.deepEqual(ticketRefFromUrl('https://jira.example.com/jira/browse/ABC-1', hosts), ref('jira', 'ABC-1'));
  assert.equal(ticketRefFromUrl('https://jira.example.com/browse/ABC-1'), null);
});

test('YouTrack issue links on YouTrack Cloud or the configured host', () => {
  for (const url of [
    'https://acme.youtrack.cloud/issue/ABC-123',
    'https://acme.youtrack.cloud/issue/ABC-123/Add-export',
    'https://acme.youtrack.cloud/issue/ABC-123/?tab=comments',
    'https://acme.myjetbrains.com/youtrack/issue/ABC-123',
  ]) {
    assert.deepEqual(ticketRefFromUrl(url), ref('youtrack', 'ABC-123'), url);
  }
  const hosts = { youtrack: 'https://yt.example.com/youtrack' };
  assert.deepEqual(ticketRefFromUrl('https://yt.example.com/youtrack/issue/ABC-7/x', hosts), ref('youtrack', 'ABC-7'));
  assert.deepEqual(ticketRefFromUrl('https://yt.example.com/issue/ABC-7', hosts), ref('youtrack', 'ABC-7'));
});

test('Azure DevOps work item links name the work item as #id', () => {
  for (const url of [
    'https://dev.azure.com/acme/Shop/_workitems/edit/123',
    'https://dev.azure.com/acme/Shop/_workitems/edit/123/',
    'https://dev.azure.com/acme/My%20Project/_workitems/edit/123?src=WorkItemMention',
    'https://acme.visualstudio.com/Shop/_workitems/edit/123',
    'https://dev.azure.com/acme/Shop/_boards/board/t/Team/Stories?workitem=123',
  ]) {
    assert.deepEqual(ticketRefFromUrl(url), ref('azure', '#123'), url);
  }
  const hosts = { azure: 'https://tfs.example.com/tfs/DefaultCollection' };
  assert.deepEqual(
    ticketRefFromUrl('https://tfs.example.com/tfs/DefaultCollection/Shop/_workitems/edit/9', hosts),
    ref('azure', '#9'),
  );
  assert.equal(ticketInputFromUrl('https://dev.azure.com/acme/Shop/_workitems/edit/123'), 'azure:#123');
});

test('a random host with an issue-like path is not a ticket', () => {
  for (const url of [
    'https://example.com/issue/ABC-123',
    'https://example.com/browse/ABC-123',
    'https://example.com/acme/_workitems/edit/12',
    'https://linear.app.evil.example/acme/issue/ABC-123',
    'https://notatlassian.net/browse/ABC-123',
    'https://example.com/?selectedIssue=ABC-123',
  ]) {
    assert.equal(ticketRefFromUrl(url), null, url);
  }
});

test('tracker hosts without an issue in the link are not tickets', () => {
  for (const url of [
    'https://linear.app/acme/project/export-1234',
    'https://linear.app/acme/team/ABC/active',
    'https://linear.app/acme/issue/',
    'https://acme.atlassian.net/wiki/spaces/ENG/pages/1/ABC-123',
    'https://acme.atlassian.net/jira/software/projects/ABC/boards/7',
    'https://acme.youtrack.cloud/issues?q=ABC-123',
    'https://dev.azure.com/acme/Shop/_workitems/edit/abc',
    'https://dev.azure.com/acme/Shop/_boards/board/t/Team/Stories',
  ]) {
    assert.equal(ticketRefFromUrl(url), null, url);
  }
});

test('keys, branches, GitHub links, and junk are left to the rest of the resolver', () => {
  for (const input of [
    'ABC-123',
    'jira:ABC-123',
    '#123',
    'my-service#feat/abc-123',
    'local:my-service#feat/x',
    'my-org/my-service#12',
    'https://github.com/my-org/my-service/issues/12',
    'https://github.com/my-org/my-service/pull/12',
    'ftp://linear.app/acme/issue/ABC-1',
    'not a url',
    '',
  ]) {
    assert.equal(ticketRefFromUrl(input), null, input);
  }
  // A PR link still goes down the pull request path.
  assert.deepEqual(
    parsePullRequestRef('https://github.com/my-org/my-service/pull/12', 'my-org'),
    { repo: 'my-service', number: 12, certain: true },
  );
});

test('row links point at the branch and, when known, the pull request', () => {
  assert.deepEqual(rowLinks('my-org', { repo: 'my-service', branch: 'feat/abc-1 x', pr_number: 12 }), {
    branch: 'https://github.com/my-org/my-service/tree/feat/abc-1%20x',
    pr: 'https://github.com/my-org/my-service/pull/12',
  });
  assert.equal(rowLinks('my-org', { repo: 'my-service', branch: 'main', pr_number: null }).pr, null);
});
