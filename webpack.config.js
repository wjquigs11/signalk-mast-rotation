const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/plugin.ts',
  mode: 'production',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    filename: 'plugin.js',
    path: path.resolve(__dirname, 'dist'),
    library: {
      type: 'commonjs2',
    },
  },
  externals: {
    '@signalk/server-api': 'commonjs @signalk/server-api',
    // Add native modules as externals to prevent webpack from trying to bundle them
    'socketcan': 'commonjs socketcan',
    'mdns': 'commonjs mdns',
    'bufferutil': 'commonjs bufferutil',
    'utf-8-validate': 'commonjs utf-8-validate'
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'public', to: 'public' },
        { from: 'package.json', to: 'package.json' },
      ],
    }),
  ],
  target: 'node',
};