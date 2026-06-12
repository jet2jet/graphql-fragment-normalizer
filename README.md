[![NPM Version](https://img.shields.io/npm/v/graphql-fragment-normalizer)](https://www.npmjs.com/package/graphql-fragment-normalizer)
[![NPM Downloads](https://img.shields.io/npm/dw/graphql-fragment-normalizer)](https://www.npmjs.com/package/graphql-fragment-normalizer)
[![Build Status](https://github.com/jet2jet/graphql-fragment-normalizer/actions/workflows/linting-and-testing.yml/badge.svg)](https://github.com/jet2jet/graphql-fragment-normalizer/actions/workflows/linting-and-testing.yml)

# graphql-fragment-normalizer

Normalizes GraphQL documents by expanding fragment spreads and inline fragments with schema-aware type checks.

This package can be used directly with GraphQL ASTs, or as a GraphQL Code Generator plugin that rewrites documents before later plugins generate their output.

- [Motivation](#motivation)
- [Usage](#usage)
  - [Installing](#installing)
  - [Using the API](#using-the-api)
  - [Using with GraphQL Code Generator](#using-with-graphql-code-generator)
  - [Options](#options)
  - [APIs](#apis)
- [Development Note](#development-note)
- [License](#license)

## Motivation

GraphQL fragments are useful for colocating field selections, but some consumers work better with operations whose fragments have already been expanded. For example, generated document strings may need to be self-contained, or downstream tooling may need to inspect the final field selection without resolving fragment references itself.

`graphql-fragment-normalizer` expands fragments while using the schema to keep only selections that are valid for the current type. It can flatten compatible fragments, preserve type-narrowing selections as inline fragments, merge repeated field selections, and optionally keep named fragments when they should remain available for generated fragment types.

Packages such as `@graphql-tools/relay-operation-optimizer` already provide operation normalization, but they are designed for Relay-style optimization and can apply broader, more complex rewrites. This package focuses on a smaller transformation surface: expanding and normalizing fragments while keeping the resulting document close to the original operation shape.

## Usage

### Installing

```sh
npm install graphql-fragment-normalizer graphql
```

### Using the API

```ts
import { buildSchema, parse, print } from 'graphql';
import { expandFragments } from 'graphql-fragment-normalizer';

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

const normalizedDocument = expandFragments(schema, document);

console.log(print(normalizedDocument));
```

Output:

```graphql
query GetUser {
  user {
    id
    name
  }
}
```

By default, fragment definitions are removed from the returned document after the operations have been expanded.

### Using with GraphQL Code Generator

Add the plugin `graphql-fragment-normalizer/codegen-plugin` before the plugin or preset that should receive normalized documents:

```ts
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: 'schema.graphql',
  documents: ['src/**/*.graphql'],
  generates: {
    'src/generated/': {
      preset: 'client',
      plugins: [
        {
          'graphql-fragment-normalizer/codegen-plugin': {
            preserveNarrowingFragments: true,
          },
        },
      ],
    },
  },
};

export default config;
```

The Code Generator plugin mutates the loaded documents in place and returns no generated content by itself. It also collects fragments from all input document files, so operations can be normalized even when fragments are split into separate files.

For Code Generator usage, fragment definitions are preserved so that later plugins can still generate colocated fragment types.

The plugin is exported through the `graphql-fragment-normalizer/codegen-plugin` subpath. If you need to import the plugin function directly, use that subpath instead of the main package entry.

The options (configurations) for the plugin can be `ExpandFragmentsOptions` as described below.

### Options

```ts
export interface ExpandFragmentsOptions {
  readonly additionalFragments?: readonly FragmentDefinitionNode[];
  readonly operationName?: string | null | undefined;
  readonly preserveNarrowingFragments?: boolean;
  readonly distributeAbstractFragments?: boolean;
  readonly preserveNamedFragmentsUsedAtLeast?: number;
  readonly fragmentDefinitionsMode?: 'drop' | 'normalize' | 'preserve';
  readonly missingFragmentBehavior?: 'error' | 'warn' | 'ignore';
  readonly typeRelationContext?: TypeRelationContext;
}
```

- `additionalFragments`: Fragment definitions supplied outside the document being expanded.
- `operationName`: Expands only the named operation. When omitted, all operations are expanded.
- `preserveNarrowingFragments`: Keeps fragments that narrow from the current type to a more specific type as inline fragments. Defaults to `true`.
- `distributeAbstractFragments`: Emits abstract narrowing fragments as inline fragments for each reachable concrete object type. Defaults to `false`.
- `preserveNamedFragmentsUsedAtLeast`: Keeps named fragment spreads when a fragment is used at least this many times. Values less than or equal to `0` disable this behavior.
- `fragmentDefinitionsMode`: Controls input `FragmentDefinition` nodes in the returned document. `drop` removes them after expansion, `preserve` keeps them unchanged, and `normalize` keeps and normalizes them. Defaults to `drop`.
- `missingFragmentBehavior`: Controls unresolved named fragment spreads. `error` throws, `warn` logs a warning and omits the spread, and `ignore` omits it silently. Defaults to `error`.
- `typeRelationContext`: Reusable type-relation cache created with `createTypeRelationContext(schema)`.

The Code Generator plugin accepts the same options except `additionalFragments`, `fragmentDefinitionsMode`, and `typeRelationContext`, which are managed internally. (The plugin always sets `fragmentDefinitionsMode` to `preserve` to keep fragment definitions for following generating processes.)

### APIs

```ts
import {
  createTypeRelationContext,
  expandFragments,
  expandFragmentsInFragment,
  type ExpandFragmentsOptions,
  type FragmentDefinitionsMode,
  type TypeRelationContext,
} from 'graphql-fragment-normalizer';
```

#### expandFragments(schema, document, options?)

Expands fragment spreads and inline fragments inside a `DocumentNode` using schema type information.

```ts
const normalizedDocument = expandFragments(schema, document, {
  fragmentDefinitionsMode: 'normalize',
  preserveNamedFragmentsUsedAtLeast: 2,
});
```

#### expandFragmentsInFragment(schema, fragment, options?)

Expands fragment spreads and inline fragments inside a single `FragmentDefinitionNode`.

```ts
const normalizedFragment = expandFragmentsInFragment(schema, fragment, {
  additionalFragments,
});
```

#### createTypeRelationContext(schema)

Creates a reusable cache for schema type relation checks. Reuse it when expanding multiple documents against the same schema.

```ts
const typeRelationContext = createTypeRelationContext(schema);

const first = expandFragments(schema, firstDocument, { typeRelationContext });
const second = expandFragments(schema, secondDocument, { typeRelationContext });
```

## Development Note

Parts of this package were developed with assistance from AI tools. The published code is reviewed, tested, and maintained by the package author.

## License

[MIT License](./LICENSE)
