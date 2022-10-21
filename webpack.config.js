const fs = require("fs");

const Webpack = require("webpack");

const {
  STAGE_ADVANCED,
  STAGE_BASIC,
} = require("webpack/lib/OptimizationStages");
const { intersect } = require("webpack/lib/util/SetHelpers");
const { BundleStatsWebpackPlugin } = require("bundle-stats-webpack-plugin");

const path = require("path");

// We're printing this way in order to highlight the parent-child
// relationships between `ChunkGroup`s.
const printWithLeftPadding = (message, paddingLength) =>
  console.log(message.padStart(message.length + paddingLength));

class UnderstandingChunkGraphPlugin {
  apply(compiler) {
    const className = this.constructor.name;
    compiler.hooks.compilation.tap(className, (compilation) => {
      // The `afterChunks` hook is called after the `ChunkGraph` has been built.
      const visualize = () => {
        // `chunks` is a set of all created chunks. The chunks are added into
        // this set based on the order in which they are created.
        // console.log(chunks);

        // As we've said earlier in the article, the `compilation` object
        // contains the state of the bundling process. Here we can also find
        // all the `ChunkGroup`s(including the `Entrypoint` instances) that have been created.
        // console.log(compilation.chunkGroups);

        // An `EntryPoint` is a type of `ChunkGroup` which is created for each
        // item in the `entry` object. In our current example, there are 2.
        // So, in order to traverse the `ChunkGraph`, we will have to start
        // from the `EntryPoints`, which are stored in the `compilation` object.
        // More about the `entrypoints` map(<string, Entrypoint>): https://github.com/webpack/webpack/blob/main/lib/Compilation.js#L956-L957
        const { entrypoints } = compilation;

        // More about the `chunkMap`(<Chunk, ChunkGraphChunk>): https://github.com/webpack/webpack/blob/main/lib/ChunkGraph.js#L226-L227
        const {
          chunkGraph: { _chunks: chunkMap },
        } = compilation;

        const printChunkGroupsInformation = (chunkGroup, paddingLength) => {
          printWithLeftPadding(
            `Current ChunkGroup's name: ${chunkGroup.name};`,
            paddingLength
          );
          printWithLeftPadding(
            `Is current ChunkGroup an EntryPoint? - ${
              chunkGroup.constructor.name === "Entrypoint"
            }`,
            paddingLength
          );

          // `chunkGroup.chunks` - a `ChunkGroup` can contain one or mode chunks.
          const allModulesInChunkGroup = chunkGroup.chunks
            .map((c) => {
              // Using the information stored in the `ChunkGraph`
              // in order to get the modules contained by a single chunk.
              const associatedGraphChunk = chunkMap.get(c);

              // This includes the *entry modules* as well.
              // Using the spread operator because `.modules` is a Set in this case.
              return {
                id: c.debugId,
                modules: [...associatedGraphChunk.modules],
              };
            })
            // The resource of a module is an absolute path and
            // we're only interested in the file name associated with
            // our module.
            .map((chunk) => {
              chunk.modules = chunk.modules.map((module) =>
                path.basename(module.resource)
              );
              return chunk;
            });

          allModulesInChunkGroup.forEach((chunk) => {
            printWithLeftPadding("Chunk: " + chunk.id, paddingLength);
            printWithLeftPadding(
              "Modules: " + chunk.modules.join(", "),
              paddingLength + 1
            );
          });
          //   printWithLeftPadding(`The modules that belong to this chunk group: ${allModulesInChunkGroup.join(', ')}`, paddingLength);

          console.log("\n");

          // A `ChunkGroup` can have children `ChunkGroup`s.
          [...chunkGroup._children].forEach((childChunkGroup) =>
            printChunkGroupsInformation(childChunkGroup, paddingLength + 3)
          );
        };

        // Traversing the `ChunkGraph` in a DFS manner.
        for (const [entryPointName, entryPoint] of entrypoints) {
          printChunkGroupsInformation(entryPoint, 0);
        }
      };
      // compilation.hooks.afterChunks.tap({name: className}, chunks => {
      //   console.log('afterChunks:');
      //   visualize();
      // });
      compilation.hooks.optimizeChunks.tap(
        { name: className, stage: STAGE_ADVANCED },
        (chunks) => {
          console.log("optimizeChunks: STAGE_ADVANCED");
          visualize();
        }
      );
    });
  }
}

class SmartMinChunkSizePlugin {
  /**
   * @param {MinChunkSizePluginOptions} options options object
   */
  constructor(options) {
    // Omit validation for now
    // validate(options);
    this.options = options;
  }

  /**
   * Apply the plugin
   * @param {Compiler} compiler the compiler instance
   * @returns {void}
   */
  apply(compiler) {
    const options = this.options;
    const minChunkSize = options.minChunkSize;
    compiler.hooks.compilation.tap("SmartMinChunkSizePlugin", (compilation) => {
      compilation.hooks.optimizeChunks.tap(
        {
          name: "SmartMinChunkSizePlugin",
          stage: STAGE_ADVANCED,
        },
        (chunks) => {
          const chunkGraph = compilation.chunkGraph;
          const equalOptions = {
            chunkOverhead: 1,
            entryChunkMultiplicator: 1,
          };
          const smallCandidates = [];
          let targetCandidates = [];
          const chunkSizesMap = new Map();

          for (const a of chunks) {
            console.log("chunk", a.getModules()[0].rawRequest);
            if (a.getNumberOfGroups() === 1) {
              console.log(
                "Chunk is either an async chunk or is needed by a single async chunk and should be handled by concatenation. Leaving it alone"
              );
              continue;
            }
            targetCandidates.push(a);
            if (chunkGraph.getChunkSize(a, equalOptions) < minChunkSize) {
              smallCandidates.push(a);
            }

            chunkSizesMap.set(a, chunkGraph.getChunkSize(a, options));
          }

          if (smallCandidates.length === 0 || targetCandidates.length === 1) {
            // We are done, no more candidates to merge
            return;
          }
          // Sort in ascending order, we want to pick the smallest candidates first.
          smallCandidates.sort(
            (a, b) => chunkSizesMap.get(a) - chunkSizesMap.get(b)
          );
          const chunkToMerge = smallCandidates[0];
          // Filter out the chunk we want to merge
          targetCandidates = targetCandidates.filter((c) => c != chunkToMerge);

          const candidateGroups = new Set(chunkToMerge.groupsIterable);
          let bestTarget = undefined;
          let bestTargetFitness = [0, 0];
          for (const target of targetCandidates) {
            if (chunkGraph.canChunksBeIntegrated(chunkToMerge, target)) {
              const targetGroups = new Set(target.groupsIterable);
              const intersectSize = intersect([
                targetGroups,
                candidateGroups,
              ]).size;
              const fitness = [
                intersectSize,
                intersectSize - targetGroups.size,
              ];
              if (fitness[0] >= bestTargetFitness[0]) {
                bestTargetFitness = fitness;
                bestTarget = target;
              } else if (
                fitness[0] === bestTargetFitness[0] &&
                fitness[1] >= bestTargetFitness[1]
              ) {
                // If same number of groups is shared with target, prefer less shared chunks over more shared ones
                bestTargetFitness = fitness;
                bestTarget = target;
              }
            }
          }
          if (!bestTarget) {
            throw new Error("Failed to find a target to integrate into!"); // I think this should never happen
          }
          chunkGraph.integrateChunks(bestTarget, chunkToMerge);
          compilation.chunks.delete(chunkToMerge);
          return true;
        }
      );
    });
  }
}

class StatsPlugin {
  constructor(options) {
    this.options = options;
  }
  apply(compiler) {
    compiler.hooks.done.tap("StatsPlugin", (stats) => {
      fs.writeFileSync(
        path.join(compiler.outputPath, "stats.json"),
        JSON.stringify(stats.toJson(this.options), null, 2)
      );
    });
  }
}

module.exports = {
  mode: "production",
  plugins: [
    // new SmartMinChunkSizePlugin({minChunkSize: 60, chunkOverhead: 0}),
    new StatsPlugin({
      all: false,
      assets: true,
      entrypoints: true,
      chunks: true,
      chunkRelations: true,
      ids: true,
      cachedAssets: true,
      children: true,
      chunkGroups: true
    }),
    new UnderstandingChunkGraphPlugin(),
  ],
  optimization: {
    chunkIds: "named",
    splitChunks: {
      maxAsyncRequests: Infinity,
      minSize: 0,
      hidePathInfo: true,
    },
    minimize: true,
  },
};

/* 
    What I need to do roughly is:
    - figure out a list of small chunks
    - find all async chunks that reference them
    - splitChunks is already smart enough to figure out when there is 100% overlap. What we need now is to figure out what to do with there *isn't* 100% overlap
    - try to group them into a smaller number of chunks to minimize the number of requests for each of those async chunks while minimizing the overhead
        - We will merge into another chunk that the async chunk depends on
        - merge into the chunk that appears the most as a dependency of the async chunks!
    - we should never combine into the async chunk itself because this will by definition decrease re-use (we'd have to duplicate somewhere else)
*/
