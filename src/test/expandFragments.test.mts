import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSchema,
  Kind,
  parse,
  print,
  type DocumentNode,
  type FragmentDefinitionNode,
} from 'graphql';
import {
  buildLayeredProfileSchema,
  buildLayeredSchema,
  layeredFragments,
  mergedNarrowingFragmentDocument,
  narrowingFragmentDocument,
} from './expandFragmentsFixtures.mts';
import expandFragments from '#main/expandFragments.mts';

void describe('expandFragments', () => {
  void it('expands fragment spreads and removes fragment definitions', () => {
    const schema = buildSchema(`
      type Query {
        user: User
      }

      type User {
        id: ID!
        name: String!
      }
    `);
    const document = parse(`
      query GetUser {
        user {
          ...UserFields
        }
      }

      fragment UserFields on User {
        id
        name
      }
    `);

    const result = expandFragments(schema, document);

    assertPrintedEqual(
      result,
      parse(`
        query GetUser {
          user {
            id
            name
          }
        }
      `)
    );
  });

  void it('uses schema type information to expand only matching fragments', () => {
    const schema = buildSchema(`
      interface Node {
        id: ID!
      }

      type User implements Node {
        id: ID!
        name: String!
        address: String
      }

      type Group implements Node {
        id: ID!
        groupId: ID!
      }

      type Query {
        user: User
      }
    `);
    const document = parse(`
      query GetUser {
        user {
          address
          ...NodeFields
        }
      }

      fragment NodeFields on Node {
        id
        ... on User {
          name
        }
        ... on Group {
          groupId
        }
      }
    `);

    const result = expandFragments(schema, document);

    assertPrintedEqual(
      result,
      parse(`
        query GetUser {
          user {
            address
            id
            name
          }
        }
      `)
    );
  });

  void it('uses schema type information to expand only matching fragments for union', () => {
    const schema = buildSchema(`
      interface Node {
        id: ID!
      }

      interface User implements Node {
        id: ID!
        name: String!
        address: String
      }

      type Owner implements Node & User {
        id: ID!
        name: String!
        address: String
        fromDate: String!
      }

      type Admin implements Node & User {
        id: ID!
        name: String!
        address: String
        adminOnly: String
      }

      union Maintainer = Owner | Admin

      type Group implements Node {
        id: ID!
        name: String!
        groupId: ID!
        users: [User!]!
        maintainers: [Maintainer!]!
      }

      type Query {
        group: Group
      }
    `);
    const document = parse(`
      query GetGroup {
        group {
          users {
            ...NodeFields
          }
          maintainers {
            ...NodeFields
          }
        }
      }

      fragment NodeFields on Node {
        id
        ... on User {
          name
        }
        ... on Group {
          groupId
        }
        ... on Owner {
          fromDate
        }
        ... on Admin {
          adminOnly
        }
      }
    `);

    const result = expandFragments(schema, document);

    assertPrintedEqual(
      result,
      parse(`
        query GetGroup {
          group {
            users {
              id
              name
              ... on Owner {
                fromDate
              }
              ... on Admin {
                adminOnly
              }
            }
            maintainers {
              ... on Node {
                id
                ... on User {
                  name
                }
                ... on Owner {
                  fromDate
                }
                ... on Admin {
                  adminOnly
                }
              }
            }
          }
        }
      `)
    );
  });

  void it('preserves directives, aliases, and arguments', () => {
    const schema = buildSchema(`
      type Query {
        user(id: ID!): User
      }

      type User {
        id: ID!
        name(format: String): String!
      }
    `);
    const document = parse(`
      query GetUser($includeName: Boolean!, $id: ID!) {
        me: user(id: $id) {
          ...UserFields
        }
      }

      fragment UserFields on User {
        displayName: name(format: "short") @include(if: $includeName)
      }
    `);

    const result = expandFragments(schema, document);

    assertPrintedEqual(
      result,
      parse(`
        query GetUser($includeName: Boolean!, $id: ID!) {
          me: user(id: $id) {
            displayName: name(format: "short") @include(if: $includeName)
          }
        }
      `)
    );
  });

  void it('uses additional fragments', () => {
    const schema = buildSchema(`
      type Query {
        user: User
      }

      type User {
        id: ID!
      }
    `);
    const document = parse(`
      query GetUser {
        user {
          ...UserFields
        }
      }
    `);
    const additionalDocument = parse(`
      fragment UserFields on User {
        id
      }
    `);
    const additionalFragments = additionalDocument.definitions.filter(
      (definition): definition is FragmentDefinitionNode =>
        definition.kind === Kind.FRAGMENT_DEFINITION
    );

    const result = expandFragments(schema, document, {
      additionalFragments,
    });

    assertPrintedEqual(
      result,
      parse(`
        query GetUser {
          user {
            id
          }
        }
      `)
    );
  });

  void it('can preserve fragment definitions without normalizing them', () => {
    const schema = buildSchema(`
      type Query {
        user: User
      }

      type User {
        id: ID!
        name: String!
      }
    `);
    const document = parse(`
      query GetUser {
        user {
          ...UserFields
        }
      }

      fragment UserFields on User {
        id
        ...UserName
      }

      fragment UserName on User {
        name
      }
    `);

    const result = expandFragments(schema, document, {
      fragmentDefinitionsMode: 'preserve',
    });

    assertPrintedEqual(
      result,
      parse(`
        query GetUser {
          user {
            id
            name
          }
        }

        fragment UserFields on User {
          id
          ...UserName
        }

        fragment UserName on User {
          name
        }
      `)
    );
  });

  void it('can normalize fragment definitions while keeping them in the document', () => {
    const schema = buildSchema(`
      type Query {
        user: User
      }

      type User {
        id: ID!
        name: String!
      }
    `);
    const document = parse(`
      query GetUser {
        user {
          ...UserFields
        }
      }

      fragment UserFields on User {
        id
        ...UserName
      }

      fragment UserName on User {
        name
      }
    `);

    const result = expandFragments(schema, document, {
      fragmentDefinitionsMode: 'normalize',
    });

    assertPrintedEqual(
      result,
      parse(`
        query GetUser {
          user {
            id
            name
          }
        }

        fragment UserFields on User {
          id
          name
        }

        fragment UserName on User {
          name
        }
      `)
    );
  });

  void it('can preserve named fragments used at least the configured count', () => {
    const schema = buildSchema(`
      type Query {
        viewer: User
        owner: User
      }

      type User {
        id: ID!
        name: String!
      }
    `);
    const document = parse(`
      query GetUsers {
        viewer {
          ...UserFields
        }
        owner {
          ...UserFields
        }
      }

      fragment UserFields on User {
        id
        name
      }
    `);

    const result = expandFragments(schema, document, {
      preserveNamedFragmentsUsedAtLeast: 2,
    });

    assertPrintedEqual(
      result,
      parse(`
        query GetUsers {
          viewer {
            ...UserFields
          }
          owner {
            ...UserFields
          }
        }

        fragment UserFields on User {
          id
          name
        }
      `)
    );
  });

  void it('expands named fragments used fewer than the configured count', () => {
    const schema = buildSchema(`
      type Query {
        user: User
      }

      type User {
        id: ID!
        name: String!
      }
    `);
    const document = parse(`
      query GetUser {
        user {
          ...UserFields
        }
      }

      fragment UserFields on User {
        id
        name
      }
    `);

    const result = expandFragments(schema, document, {
      preserveNamedFragmentsUsedAtLeast: 2,
    });

    assertPrintedEqual(
      result,
      parse(`
        query GetUser {
          user {
            id
            name
          }
        }
      `)
    );
  });

  void it('counts named fragment usage from other named fragments', () => {
    const schema = buildSchema(`
      type Query {
        viewer: User
        owner: User
      }

      type User {
        id: ID!
        name: String!
        viewerOnly: String
        ownerOnly: String
      }
    `);
    const document = parse(`
      query GetUsers {
        viewer {
          ...ViewerFields
        }
        owner {
          ...OwnerFields
        }
      }

      fragment ViewerFields on User {
        viewerOnly
        ...SharedUserFields
      }

      fragment OwnerFields on User {
        ownerOnly
        ...SharedUserFields
      }

      fragment SharedUserFields on User {
        id
        name
      }
    `);

    const result = expandFragments(schema, document, {
      preserveNamedFragmentsUsedAtLeast: 2,
    });

    assertPrintedEqual(
      result,
      parse(`
        query GetUsers {
          viewer {
            viewerOnly
            ...SharedUserFields
          }
          owner {
            ownerOnly
            ...SharedUserFields
          }
        }

        fragment SharedUserFields on User {
          id
          name
        }
      `)
    );
  });

  void it('keeps fragment definitions referenced by preserved fragment definitions', () => {
    const schema = buildSchema(`
      type Query {
        viewer: User
        owner: User
      }

      type User {
        id: ID!
        name: String!
      }
    `);
    const document = parse(`
      query GetUsers {
        viewer {
          ...UserCard
        }
        owner {
          ...UserCard
        }
      }

      fragment UserCard on User {
        id
        ...UserName
      }

      fragment UserName on User {
        name
      }
    `);

    const result = expandFragments(schema, document, {
      preserveNamedFragmentsUsedAtLeast: 2,
    });

    assertPrintedEqual(
      result,
      parse(`
        query GetUsers {
          viewer {
            ...UserCard
          }
          owner {
            ...UserCard
          }
        }

        fragment UserCard on User {
          id
          ...UserName
        }

        fragment UserName on User {
          name
        }
      `)
    );
  });

  void it('expands only the selected operation when operationName is provided', () => {
    const schema = buildSchema(`
      type Query {
        user: User
      }

      type User {
        id: ID!
        name: String!
      }
    `);
    const document = parse(`
      query GetUserId {
        user {
          id
        }
      }

      query GetUserName {
        user {
          ...UserName
        }
      }

      fragment UserName on User {
        name
      }
    `);

    const result = expandFragments(schema, document, {
      operationName: 'GetUserName',
    });

    assertPrintedEqual(
      result,
      parse(`
        query GetUserId {
          user {
            id
          }
        }

        query GetUserName {
          user {
            name
          }
        }
      `)
    );
  });

  void it('throws when fragments reference each other circularly', () => {
    const schema = buildSchema(`
      type Query {
        user: User
      }

      type User {
        id: ID!
      }
    `);
    const document = parse(`
      query GetUser {
        user {
          ...First
        }
      }

      fragment First on User {
        ...Second
      }

      fragment Second on User {
        ...First
      }
    `);

    assert.throws(
      () => expandFragments(schema, document),
      /Circular fragment reference detected: First -> Second -> First/
    );
  });

  void it('merges fields read by multiple fragments without duplicating selections', () => {
    const schema = buildSchema(`
      type Query {
        user: User
      }

      type User {
        id: ID!
        name: String!
        profile: Profile
      }

      type Profile {
        bio: String
        avatar: String
      }
    `);
    const document = parse(`
      query GetUser {
        user {
          ...UserIdentity
          ...UserDisplay
          profile {
            ...ProfileBio
            ...ProfileAvatar
          }
        }
      }

      fragment UserIdentity on User {
        id
        name
        profile {
          bio
        }
      }

      fragment UserDisplay on User {
        name
        profile {
          bio
          avatar
        }
      }

      fragment ProfileBio on Profile {
        bio
      }

      fragment ProfileAvatar on Profile {
        avatar
      }
    `);

    const result = expandFragments(schema, document);

    assertPrintedEqual(
      result,
      parse(`
        query GetUser {
          user {
            id
            name
            profile {
              bio
              avatar
            }
          }
        }
      `)
    );
  });

  void it('preserves narrowing fragments from a broad base type by default', () => {
    const schema = buildLayeredSchema();
    const document = parse(narrowingFragmentDocument);

    const result = expandFragments(schema, document);

    assertPrintedEqual(
      result,
      parse(`
        query GetNode {
          node {
            nodeKey
            id
            createdAt
            ... on User {
              name
              userOnly
            }
            ... on Group {
              groupId
            }
          }
        }
      `)
    );
  });

  void it('preserves narrowing fragments while merging their selections', () => {
    const schema = buildLayeredProfileSchema();
    const document = parse(mergedNarrowingFragmentDocument);

    const result = expandFragments(schema, document);

    assertPrintedEqual(
      result,
      parse(`
        query GetNode {
          node {
            nodeKey
            ... on User {
              name
              profile {
                bio
                avatar
              }
            }
            ... on Group {
              groupId
            }
          }
        }
      `)
    );
  });

  void it('omits impossible inline fragment branches', () => {
    const schema = buildLayeredProfileSchema();
    const document = parse(`
      query GetNode {
        node {
          nodeKey
          ... on Admin {
            adminOnly
          }
        }
      }
    `);

    const result = expandFragments(schema, document);

    assertPrintedEqual(
      result,
      parse(`
        query GetNode {
          node {
            nodeKey
          }
        }
      `)
    );
  });

  void it('can omit narrowing fragments from a broad base type', () => {
    const schema = buildLayeredSchema();
    const document = parse(`
      query GetNode {
        node {
          ...NodeRoot
        }
      }

      ${layeredFragments}
    `);

    const result = expandFragments(schema, document, {
      preserveNarrowingFragments: false,
    });

    assertPrintedEqual(
      result,
      parse(`
        query GetNode {
          node {
            nodeKey
            id
            createdAt
          }
        }
      `)
    );
  });

  void it('keeps only fields matching a narrow base type through nested fragments', () => {
    const schema = buildLayeredSchema();
    const document = parse(`
      query GetUser {
        user {
          ...NodeRoot
        }
      }

      ${layeredFragments}
    `);

    const result = expandFragments(schema, document);

    assertPrintedEqual(
      result,
      parse(`
        query GetUser {
          user {
            nodeKey
            id
            createdAt
            name
            userOnly
          }
        }
      `)
    );
  });
});

function assertPrintedEqual(
  actual: DocumentNode,
  expected: DocumentNode
): void {
  assert.equal(print(actual), print(expected));
}
