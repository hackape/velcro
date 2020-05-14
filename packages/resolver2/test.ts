import { read, request } from '@hapi/wreck';
import { CancellationToken } from 'ts-primitives';
import { CanceledError, execute } from './src';
import { polly } from './test/lib/wreck';

async function fetchBufferWithWreck(href: string, token: CancellationToken) {
  const resPromise = request('get', href, {
    redirects: 3,
    timeout: 50000,
  });

  token.onCancellationRequested(() => resPromise.req.destroy(new CanceledError()));

  const res = await resPromise;

  if (res.statusCode === 404) {
    return null;
  }

  if (res.statusCode !== 200) {
    throw new Error(`Error while reading from '${href}': ${res.statusCode} - ${res.statusMessage}`);
  }

  return read(res);
}

async function main() {
  // polly.record();
  polly.replay();

  // const rootFs = MemFs.Volume.fromJSON(
  //   {
  //     'package.json': JSON.stringify({
  //       name: 'test',
  //       version: '1.0.0',
  //       dependencies: {
  //         'react-ui': '^1.0.0-beta.25',
  //       },
  //     }),
  //     'index.js': 'module.exports = require("react-ui");',
  //   },
  //   '/'
  // );
  // const fsStrategy = new FsStrategy({
  //   fs: MemFs.createFsFromVolume(rootFs) as FsStrategy.FsInterface,
  // });
  // const cdnStrategy = CdnStrategy.forJsDelivr(fetchBufferWithWreck);
  // const strategy = new CompoundStrategy({
  //   strategies: [cdnStrategy, fsStrategy],
  // });
  // const resolver = new Resolver(strategy, {
  //   extensions: ['.js', '.json'],
  //   packageMain: ['main'],
  // });

  // const start = process.hrtime();
  // let graph: Graph;
  // try {
  //   graph = await buildGraph({
  //     entrypoints: [Uri.file('')],
  //     resolver,
  //     nodeEnv: 'development',
  //   });
  // } catch (err) {
  //   console.trace(err);
  //   return;
  // } finally {
  //   const delta = process.hrtime(start);

  //   console.error(delta[0] * 1_000 + delta[1] / 1_000_000);

  //   await polly.stop();
  // }

  // for (const chunk of graph.splitChunks()) {
  //   const build = chunk.buildForStaticRuntime({
  //     href: 'chunk.js',
  //     injectRuntime: true,
  //   });
  //   const { promises: fs } = await import('fs');

  //   await fs.writeFile('./chunk.js', `${build.code}\n//# sourceMappingURL=${build.href}.map\n`);
  //   await fs.writeFile('./chunk.js.map', `${build.sourceMapString}\n`);
  // }

  console.time('Load and execute react');
  const React = await execute('module.exports = require("react")', {
    dependencies: {
      react: '16.13.x',
    },
    readUrl: fetchBufferWithWreck,
  });
  console.timeEnd('Load and execute react');

  console.log('react', React);
}

main();
