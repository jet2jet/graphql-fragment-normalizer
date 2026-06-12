import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: [
    {
      'src/test/codegen-plugin/schema.graphql': {},
    },
  ],
  documents: ['.work/codegen-plugin-near-src/*.graphql'],
  generates: {
    '.work/codegen-plugin-near-output/': {
      preset: 'near-operation-file',
      presetConfig: {
        extension: '.expanded.graphql',
      },
      plugins: [
        {
          './src/main/codegen-plugin/index.mts': {},
        },
        {
          './src/test/codegen-plugin/print-documents-plugin.mts': {},
        },
      ],
    },
  },
};

export default config;
