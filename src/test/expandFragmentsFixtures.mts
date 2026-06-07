import { buildSchema } from 'graphql';

export const layeredFragments = `
  fragment NodeRoot on Node {
    nodeKey
    ...EntityLayer
    ...UserLayer
    ...GroupLayer
  }

  fragment EntityLayer on Entity {
    id
    createdAt
    ...NodeLayer
  }

  fragment NodeLayer on Entity {
    ... on Node {
      nodeKey
      ...EntityTail
    }
  }

  fragment EntityTail on Entity {
    createdAt
    ...UserLayer
  }

  fragment UserLayer on Entity {
    ... on User {
      name
      userOnly
    }
  }

  fragment GroupLayer on Node {
    ... on Group {
      groupId
    }
  }
`;

export const layeredSchemaSdl = `
  interface Entity {
    id: ID!
    createdAt: String!
  }

  interface Node implements Entity {
    id: ID!
    createdAt: String!
    nodeKey: ID!
  }

  type User implements Entity & Node {
    id: ID!
    createdAt: String!
    nodeKey: ID!
    name: String!
    userOnly: String
  }

  type Group implements Entity & Node {
    id: ID!
    createdAt: String!
    nodeKey: ID!
    groupId: ID!
  }

  type Query {
    node: Node
    user: User
  }
`;

export const layeredProfileSchemaSdl = `
  interface Entity {
    id: ID!
    createdAt: String!
  }

  interface Node implements Entity {
    id: ID!
    createdAt: String!
    nodeKey: ID!
  }

  type User implements Entity & Node {
    id: ID!
    createdAt: String!
    nodeKey: ID!
    name: String!
    profile: Profile
  }

  type Group implements Entity & Node {
    id: ID!
    createdAt: String!
    nodeKey: ID!
    groupId: ID!
  }

  type Admin implements Entity {
    id: ID!
    createdAt: String!
    adminOnly: String
  }

  type Profile {
    bio: String
    avatar: String
  }

  type Query {
    node: Node
  }
`;

export const narrowingFragmentDocument = `
  query GetNode {
    node {
      ...NodeRoot
    }
  }

  ${layeredFragments}
`;

export const mergedNarrowingFragmentDocument = `
  query GetNode {
    node {
      ...NodeProfileRoot
    }
  }

  fragment NodeProfileRoot on Node {
    nodeKey
    ...UserSummary
    ...UserProfile
    ...GroupSummary
    ... on User {
      profile {
        bio
      }
    }
  }

  fragment UserSummary on Node {
    ... on User {
      name
      profile {
        bio
      }
      ...UserAvatar
    }
  }

  fragment UserProfile on Node {
    ... on User {
      name
      profile {
        avatar
      }
    }
  }

  fragment UserAvatar on Node {
    ... on User {
      profile {
        avatar
      }
    }
  }

  fragment GroupSummary on Node {
    ... on Group {
      groupId
    }
  }
`;

export function buildLayeredSchema(): ReturnType<typeof buildSchema> {
  return buildSchema(layeredSchemaSdl);
}

export function buildLayeredProfileSchema(): ReturnType<typeof buildSchema> {
  return buildSchema(layeredProfileSchemaSdl);
}
