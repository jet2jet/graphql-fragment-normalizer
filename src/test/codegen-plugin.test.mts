import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { buildSchema, parse, print, type DocumentNode } from 'graphql';
import { plugin } from '#main/codegen-plugin/index.mts';

void describe('codegen-plugin', () => {
  void it('expands fragments across multiple input files', async () => {
    const schema = buildSchema(`
      type Query {
        user: User
      }

      type User {
        id: ID!
        name: String!
      }
    `);
    const operationDocument = parse(`
      query GetUser {
        user {
          ...UserFields
        }
      }
    `);
    const fragmentDocument = parse(`
      fragment UserFields on User {
        id
        name
      }
    `);
    const documents = [
      {
        location: 'operation.graphql',
        document: operationDocument,
      },
      {
        location: 'fragment.graphql',
        document: fragmentDocument,
      },
    ];

    await plugin(schema, documents, {});

    assertPrintedEqual(
      documents[0]!.document,
      parse(`
        query GetUser {
          user {
            id
            name
          }
        }
      `)
    );
    assertPrintedEqual(
      documents[1]!.document,
      parse(`
        fragment UserFields on User {
          id
          name
        }
      `)
    );
  });

  void it('expands fragments supplied through externalFragments config', async () => {
    const schema = buildSchema(`
      type Query {
        user: User
      }

      type User {
        id: ID!
        name: String!
      }
    `);
    const operationDocument = parse(`
      query GetUser {
        user {
          ...UserFields
        }
      }
    `);
    const fragmentDocument = parse(`
      fragment UserFields on User {
        id
        name
      }
    `);
    const fragmentDefinition = fragmentDocument.definitions[0];
    assert.equal(fragmentDefinition?.kind, 'FragmentDefinition');
    const documents = [
      {
        location: 'operation.graphql',
        document: operationDocument,
      },
    ];

    await plugin(schema, documents, {
      externalFragments: [
        {
          name: 'UserFields',
          onType: 'User',
          node: fragmentDefinition,
          isExternal: true,
          importFrom: './userFields.graphql',
        },
      ],
    });

    assertPrintedEqual(
      documents[0]!.document,
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

  void it('passes expandFragments options through config', async () => {
    const schema = buildSchema(`
      interface Node {
        id: ID!
      }

      type User implements Node {
        id: ID!
        name: String!
      }

      type Query {
        node: Node
      }
    `);
    const document = parse(`
      query GetNode {
        node {
          id
          ... on User {
            name
          }
        }
      }
    `);
    const documents = [
      {
        location: 'operation.graphql',
        document,
      },
    ];

    await plugin(schema, documents, {
      preserveNarrowingFragments: false,
    });

    assertPrintedEqual(
      documents[0]!.document,
      parse(`
          query GetNode {
            node {
              id
            }
          }
        `)
    );
  });

  void it('generates an expanded GetUserDocument with graphql-codegen', () => {
    runGraphqlCodegen();

    const generatedSource = readFileSync(
      join(process.cwd(), '.work/codegen-plugin/graphql.ts'),
      'utf8'
    );
    const getUserDocument = extractTypedDocumentString(
      generatedSource,
      'GetUserDocument'
    );

    assert.doesNotMatch(getUserDocument, /\.\.\.UserFields/);
    assertPrintedEqual(
      parse(getUserDocument),
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

  void it('expands external fragments with near-operation-file preset', () => {
    prepareNearOperationFileFixture();
    runGraphqlCodegen('src/test/codegen-plugin/near-operation-file-codegen.mts');

    const generatedSource = readFileSync(
      join(
        process.cwd(),
        '.work/codegen-plugin-near-src/operation.expanded.graphql'
      ),
      'utf8'
    );

    assert.doesNotMatch(generatedSource, /\.\.\.UserFields/);
    assertPrintedEqual(
      parse(generatedSource),
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
});

function assertPrintedEqual(
  actual: DocumentNode,
  expected: DocumentNode
): void {
  assert.equal(print(actual), print(expected));
}

function prepareNearOperationFileFixture(): void {
  const fixtureDirectory = join(process.cwd(), '.work/codegen-plugin-near-src');
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(
    join(fixtureDirectory, 'operation.graphql'),
    `
      query GetUser {
        user {
          ...UserFields
        }
      }
    `
  );
  writeFileSync(
    join(fixtureDirectory, 'userFields.graphql'),
    `
      fragment UserFields on User {
        id
        name
      }
    `
  );
}

function runGraphqlCodegen(
  configPath = 'src/test/codegen-plugin/codegen.mts'
): void {
  const nodeBinDirectory = dirname(process.execPath);
  execFileSync(
    join(nodeBinDirectory, process.platform === 'win32' ? 'npx.cmd' : 'npx'),
    ['graphql-codegen', '--config', configPath],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${nodeBinDirectory}:${process.env.PATH ?? ''}`,
      },
      stdio: 'pipe',
    }
  );
}

function extractTypedDocumentString(
  source: string,
  exportName: string
): string {
  const exportPrefix = `export const ${exportName} = new TypedDocumentString(`;
  const exportStart = source.indexOf(exportPrefix);
  if (exportStart < 0) {
    assert.fail(`Could not find ${exportName} export`);
  }

  const templateStart = source.indexOf('`', exportStart);
  if (templateStart < 0) {
    assert.fail(`Could not find ${exportName} document string`);
  }

  for (let index = templateStart + 1; index < source.length; index += 1) {
    if (source.charAt(index) === '`' && source.charAt(index - 1) !== '\\') {
      return source.slice(templateStart + 1, index);
    }
  }

  assert.fail(`Could not find end of ${exportName} document string`);
}
