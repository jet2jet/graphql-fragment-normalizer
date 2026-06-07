import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: [
    {
      'src/test/codegen-plugin/schema.graphql': {},
    },
  ],
  documents: [
    'src/test/codegen-plugin/operation.graphql',
    'src/test/codegen-plugin/userFields.graphql',
  ],
  generates: {
    '.work/codegen-plugin/': {
      preset: 'client',
      config: {
        documentMode: 'string',
      },
      plugins: [
        {
          './src/main/codegen-plugin/index.mts': {},
        },
      ],
    },
  },
};

export default config;
