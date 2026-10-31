/* Example stores for the playground: model DSL, tuples, suggested queries and assertions. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FGA_EXAMPLES = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return [
    {
      id: 'drive',
      name: 'Google Drive',
      blurb: 'Folders, docs, nested groups, inherited viewers and a public (wildcard) doc. The canonical "viewer from parent" model.',
      tags: ['tuple-to-userset', 'usersets', 'wildcard', 'exclusion'],
      dsl: `model
  schema 1.1

type user

type group
  relations
    define member: [user, group#member]

type folder
  relations
    define owner: [user]
    define parent: [folder]
    define viewer: [user, user:*, group#member] or owner or viewer from parent

type doc
  relations
    define parent: [folder]
    define owner: [user]
    define editor: [user, group#member] or owner
    define viewer: [user, user:*, group#member] or editor or viewer from parent
    define blocked: [user]
    define can_comment: viewer but not blocked
    define can_share: owner
`,
      tuples: `# people and groups
user:anne member group:engineering
user:bob member group:engineering
group:engineering#member member group:everyone
user:charlie member group:everyone

# folder tree: company ⟶ product
user:ceo owner folder:company
folder:company parent folder:product
group:engineering#member viewer folder:product

# docs
folder:product parent doc:roadmap
folder:product parent doc:okrs
user:anne owner doc:roadmap
user:bob editor doc:okrs
user:* viewer doc:handbook
user:dave viewer doc:roadmap
user:dave blocked doc:roadmap
`,
      queries: [
        { type: 'check', user: 'user:bob', relation: 'viewer', object: 'doc:roadmap', note: 'group → folder → inherited through parent' },
        { type: 'check', user: 'user:charlie', relation: 'viewer', object: 'doc:roadmap', note: 'in group:everyone, but not engineering' },
        { type: 'check', user: 'user:dave', relation: 'can_comment', object: 'doc:roadmap', note: 'viewer, yet blocked (but not)' },
        { type: 'listObjects', user: 'user:anne', relation: 'viewer', objectType: 'doc', note: 'owner, folder and wildcard paths' },
        { type: 'listUsers', object: 'doc:roadmap', relation: 'viewer', userType: 'user' },
        { type: 'expand', object: 'doc:roadmap', relation: 'viewer' },
      ],
      assertions: [
        { user: 'user:bob', relation: 'viewer', object: 'doc:roadmap', expected: true },
        { user: 'user:charlie', relation: 'viewer', object: 'doc:roadmap', expected: false },
        { user: 'user:dave', relation: 'can_comment', object: 'doc:roadmap', expected: false },
        { user: 'user:charlie', relation: 'viewer', object: 'doc:handbook', expected: true },
        { user: 'user:ceo', relation: 'viewer', object: 'doc:okrs', expected: true },
      ],
    },
    {
      id: 'github',
      name: 'GitHub',
      blurb: 'Organizations, nested teams and repositories with role hierarchies. can_push needs both a repo role and org membership.',
      tags: ['intersection', 'role hierarchy', 'tuple-to-userset', 'usersets'],
      dsl: `model
  schema 1.1

type user

type organization
  relations
    define owner: [user]
    define member: [user] or owner
    define repo_admin: [user, team#member]
    define repo_writer: [user, team#member] or repo_admin
    define repo_reader: [user, team#member] or repo_writer

type team
  relations
    define member: [user, team#member]

type repo
  relations
    define owner: [organization]
    define admin: [user, team#member] or repo_admin from owner
    define maintainer: [user, team#member] or admin
    define writer: [user, team#member] or maintainer or repo_writer from owner
    define triager: [user, team#member] or writer
    define reader: [user, team#member] or triager or repo_reader from owner
    define can_push: writer and member from owner
`,
      tuples: `user:alice owner organization:acme
user:bob member organization:acme
user:erin member organization:acme

user:bob member team:backend
user:erin member team:frontend
team:frontend#member member team:web

organization:acme owner repo:acme/api
organization:acme owner repo:acme/web

team:backend#member writer repo:acme/api
team:web#member reader repo:acme/web
user:erin writer repo:acme/web
user:mallory writer repo:acme/api
team:backend#member repo_reader organization:acme
`,
      queries: [
        { type: 'check', user: 'user:bob', relation: 'reader', object: 'repo:acme/web', note: 'org-wide repo_reader inherited into every repo' },
        { type: 'check', user: 'user:mallory', relation: 'can_push', object: 'repo:acme/api', note: 'writer, but not an org member (and)' },
        { type: 'listObjects', user: 'user:erin', relation: 'can_push', objectType: 'repo', note: 'candidates must be verified with Check' },
        { type: 'listUsers', object: 'repo:acme/api', relation: 'reader', userType: 'user' },
        { type: 'expand', object: 'repo:acme/web', relation: 'reader' },
      ],
      assertions: [
        { user: 'user:bob', relation: 'reader', object: 'repo:acme/web', expected: true },
        { user: 'user:mallory', relation: 'can_push', object: 'repo:acme/api', expected: false },
        { user: 'user:erin', relation: 'can_push', object: 'repo:acme/web', expected: true },
        { user: 'user:alice', relation: 'admin', object: 'repo:acme/api', expected: false },
      ],
    },
    {
      id: 'slack',
      name: 'Slack',
      blurb: 'Workspaces and channels. Posting requires being a channel writer AND a workspace member, so guests are kept out.',
      tags: ['intersection', 'usersets', 'wildcard'],
      dsl: `model
  schema 1.1

type user

type workspace
  relations
    define legacy_admin: [user]
    define channels_admin: [user] or legacy_admin
    define member: [user] or channels_admin
    define guest: [user]

type channel
  relations
    define parent_workspace: [workspace]
    define writer: [user, workspace#member]
    define commenter: [user, workspace#member] or writer
    define viewer: [user, user:*, workspace#member] or commenter
    define can_post: writer and member from parent_workspace
`,
      tuples: `user:amy legacy_admin workspace:sandcastle
user:bob channels_admin workspace:sandcastle
user:catherine member workspace:sandcastle
user:david guest workspace:sandcastle

workspace:sandcastle parent_workspace channel:general
workspace:sandcastle parent_workspace channel:proj-marketing

workspace:sandcastle#member writer channel:general
user:* viewer channel:general
user:catherine writer channel:proj-marketing
user:david writer channel:proj-marketing
`,
      queries: [
        { type: 'check', user: 'user:david', relation: 'can_post', object: 'channel:proj-marketing', note: 'guest: writer but not member' },
        { type: 'check', user: 'user:bob', relation: 'writer', object: 'channel:general', note: 'channels_admin → member → writer userset' },
        { type: 'listUsers', object: 'channel:general', relation: 'writer', userType: 'user' },
        { type: 'listObjects', user: 'user:david', relation: 'viewer', objectType: 'channel' },
      ],
      assertions: [
        { user: 'user:david', relation: 'can_post', object: 'channel:proj-marketing', expected: false },
        { user: 'user:catherine', relation: 'can_post', object: 'channel:proj-marketing', expected: true },
        { user: 'user:amy', relation: 'writer', object: 'channel:general', expected: true },
        { user: 'user:david', relation: 'viewer', object: 'channel:general', expected: true },
      ],
    },
    {
      id: 'expenses',
      name: 'Expense approvals',
      blurb: 'Management chains resolved recursively (can_manage from manager). You can approve a report only if you are not its submitter.',
      tags: ['exclusion', 'recursive tuple-to-userset', 'wildcard'],
      dsl: `model
  schema 1.1

type employee
  relations
    define manager: [employee]
    define can_manage: manager or can_manage from manager

type report
  relations
    define submitter: [employee]
    define approver: [employee] or can_manage from submitter
    define can_approve: approver but not submitter
    define auditor: [employee, employee:*]
    define can_view: submitter or approver or auditor
`,
      tuples: `# daniel manages matt, matt manages sam
employee:daniel manager employee:matt
employee:matt manager employee:sam

employee:sam submitter report:1001
employee:sam approver report:1001
employee:matt submitter report:1002
employee:carol auditor report:1001
`,
      queries: [
        { type: 'check', user: 'employee:sam', relation: 'can_approve', object: 'report:1001', note: 'approver, but excluded as submitter' },
        { type: 'check', user: 'employee:daniel', relation: 'can_approve', object: 'report:1001', note: 'two levels up the chain' },
        { type: 'listUsers', object: 'report:1001', relation: 'can_approve', userType: 'employee' },
        { type: 'listObjects', user: 'employee:matt', relation: 'can_approve', objectType: 'report' },
      ],
      assertions: [
        { user: 'employee:sam', relation: 'can_approve', object: 'report:1001', expected: false },
        { user: 'employee:daniel', relation: 'can_approve', object: 'report:1001', expected: true },
        { user: 'employee:matt', relation: 'can_approve', object: 'report:1002', expected: false },
        { user: 'employee:carol', relation: 'can_view', object: 'report:1001', expected: true },
      ],
    },
    {
      id: 'entitlements',
      name: 'SaaS entitlements',
      blurb: 'Plans grant features to every member of a subscribing organization: two chained tuple-to-usersets with no direct user tuples.',
      tags: ['tuple-to-userset', 'entitlements'],
      dsl: `model
  schema 1.1

type user

type organization
  relations
    define member: [user]

type plan
  relations
    define subscriber: [organization]
    define subscriber_member: member from subscriber

type feature
  relations
    define associated_plan: [plan]
    define access: subscriber_member from associated_plan
`,
      tuples: `user:anne member organization:acme
user:beth member organization:globex

organization:acme subscriber plan:enterprise
organization:globex subscriber plan:team

plan:enterprise associated_plan feature:sso
plan:enterprise associated_plan feature:issues
plan:team associated_plan feature:issues
`,
      queries: [
        { type: 'check', user: 'user:anne', relation: 'access', object: 'feature:sso' },
        { type: 'listObjects', user: 'user:beth', relation: 'access', objectType: 'feature' },
        { type: 'listUsers', object: 'feature:issues', relation: 'access', userType: 'user' },
        { type: 'expand', object: 'feature:sso', relation: 'access' },
      ],
      assertions: [
        { user: 'user:anne', relation: 'access', object: 'feature:sso', expected: true },
        { user: 'user:beth', relation: 'access', object: 'feature:sso', expected: false },
        { user: 'user:beth', relation: 'access', object: 'feature:issues', expected: true },
      ],
    },
    {
      id: 'conditions',
      name: 'Conditional access',
      blurb: 'Time-boxed grants and office-network-only editing. Conditions are evaluated against context passed with the query.',
      tags: ['conditions', 'context', 'temporal access'],
      dsl: `model
  schema 1.1

type user

type document
  relations
    define owner: [user]
    define viewer: [user, user with non_expired_grant] or owner
    define editor: [user with in_office_network] or owner

condition non_expired_grant(current_time: timestamp, grant_time: timestamp, grant_duration: duration) {
  current_time < grant_time + grant_duration
}

condition in_office_network(user_ip: ipaddress, allowed_cidr: string) {
  user_ip.in_cidr(allowed_cidr)
}
`,
      tuples: `user:anne owner document:secret
user:bob viewer document:secret with non_expired_grant {"grant_time": "2026-10-31T09:00:00Z", "grant_duration": "4h"}
user:carla editor document:secret with in_office_network {"allowed_cidr": "10.0.0.0/8"}
user:dan viewer document:public
`,
      queries: [
        { type: 'check', user: 'user:bob', relation: 'viewer', object: 'document:secret', context: { current_time: '2026-10-31T11:30:00Z' }, note: 'inside the 4h window' },
        { type: 'check', user: 'user:bob', relation: 'viewer', object: 'document:secret', context: { current_time: '2026-10-31T15:00:00Z' }, note: 'grant expired' },
        { type: 'check', user: 'user:carla', relation: 'editor', object: 'document:secret', context: { user_ip: '10.4.2.1' } },
        { type: 'listUsers', object: 'document:secret', relation: 'viewer', userType: 'user', context: { current_time: '2026-10-31T10:00:00Z' } },
      ],
      assertions: [
        { user: 'user:bob', relation: 'viewer', object: 'document:secret', context: { current_time: '2026-10-31T11:30:00Z' }, expected: true },
        { user: 'user:bob', relation: 'viewer', object: 'document:secret', context: { current_time: '2026-10-31T15:00:00Z' }, expected: false },
        { user: 'user:carla', relation: 'editor', object: 'document:secret', context: { user_ip: '192.168.1.5' }, expected: false },
      ],
    },
    {
      id: 'roles',
      name: 'Custom roles',
      blurb: 'Role objects as assignable permission bundles: projects point at roles, roles have assignees (users or whole teams).',
      tags: ['tuple-to-userset', 'usersets', 'RBAC'],
      dsl: `model
  schema 1.1

type user

type team
  relations
    define member: [user]

type role
  relations
    define assignee: [user, team#member]

type project
  relations
    define owner: [user]
    define viewer_role: [role]
    define editor_role: [role]
    define can_edit: assignee from editor_role or owner
    define can_view: assignee from viewer_role or can_edit
`,
      tuples: `role:apollo-viewers viewer_role project:apollo
role:apollo-editors editor_role project:apollo

user:anne assignee role:apollo-editors
team:design#member assignee role:apollo-viewers
user:bob member team:design
user:ceo owner project:apollo
`,
      queries: [
        { type: 'check', user: 'user:bob', relation: 'can_view', object: 'project:apollo', note: 'role → team userset' },
        { type: 'check', user: 'user:bob', relation: 'can_edit', object: 'project:apollo' },
        { type: 'listUsers', object: 'project:apollo', relation: 'can_view', userType: 'user' },
        { type: 'expand', object: 'project:apollo', relation: 'can_view' },
      ],
      assertions: [
        { user: 'user:bob', relation: 'can_view', object: 'project:apollo', expected: true },
        { user: 'user:bob', relation: 'can_edit', object: 'project:apollo', expected: false },
        { user: 'user:anne', relation: 'can_view', object: 'project:apollo', expected: true },
      ],
    },
    {
      id: 'org-team-roles',
      name: 'Org & team roles',
      blurb: 'Role slots (role_admin, role_member, role_guest) on organizations and teams, derived admin/member/collaborator, and team membership inherited from the org.',
      tags: ['roles', 'computed usersets', 'tuple-to-userset'],
      dsl: `model
  schema 1.1

type user

type organization
  relations
    define role_admin: [user]
    define role_member: [user]
    define role_guest: [user]

    define admin: role_admin
    define member: role_admin or role_member
    define collaborator: member or role_guest

type team
  relations
    define org: [organization]

    define role_admin: [user]
    define role_member: [user]
    define role_guest: [user]

    define admin: role_admin
    define member: role_admin or role_member
    define collaborator: member or role_guest or org_member

    define org_member: member from org
`,
      tuples: `user:alice role_admin organization:acme
user:bob role_member organization:acme
user:carol role_guest organization:acme

organization:acme org team:platform
user:dave role_member team:platform
user:erin role_guest team:platform
`,
      queries: [
        { type: 'check', user: 'user:bob', relation: 'collaborator', object: 'team:platform', note: 'org member → team collaborator through "member from org"' },
        { type: 'check', user: 'user:carol', relation: 'collaborator', object: 'team:platform', note: 'org guest is not an org member' },
        { type: 'listUsers', object: 'team:platform', relation: 'collaborator', userType: 'user' },
        { type: 'listObjects', user: 'user:alice', relation: 'admin', objectType: 'team' },
      ],
      assertions: [
        { user: 'user:bob', relation: 'collaborator', object: 'team:platform', expected: true },
        { user: 'user:carol', relation: 'collaborator', object: 'team:platform', expected: false },
        { user: 'user:alice', relation: 'admin', object: 'team:platform', expected: false },
        { user: 'user:dave', relation: 'member', object: 'team:platform', expected: true },
      ],
    },
    {
      id: 'cycles',
      name: 'Recursive groups',
      blurb: 'Groups that contain each other. Watch the resolver detect the cycle instead of looping forever.',
      tags: ['cycle detection', 'usersets'],
      dsl: `model
  schema 1.1

type user

type group
  relations
    define member: [user, group#member]
`,
      tuples: `group:a#member member group:b
group:b#member member group:a
user:zed member group:a
`,
      queries: [
        { type: 'check', user: 'user:yan', relation: 'member', object: 'group:a', note: 'denied, with a cycle stop' },
        { type: 'check', user: 'user:zed', relation: 'member', object: 'group:b', note: 'allowed through group:a' },
        { type: 'listUsers', object: 'group:b', relation: 'member', userType: 'user' },
        { type: 'listObjects', user: 'user:zed', relation: 'member', objectType: 'group' },
      ],
      assertions: [
        { user: 'user:yan', relation: 'member', object: 'group:a', expected: false },
        { user: 'user:zed', relation: 'member', object: 'group:b', expected: true },
      ],
    },
  ];
});
