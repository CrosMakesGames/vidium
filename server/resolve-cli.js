#!/usr/bin/env node
/**
 * resolve-cli.js
 * CLI runner for vidsrc-resolve module.
 *
 * Usage:
 *   node resolve-cli.js tv <tmdbId> [season] [episode]
 *   node resolve-cli.js movie <tmdbId>
 *   node resolve-cli.js --type=tv --tmdbId=105248 --season=1 --episode=1
 */

const { resolve } = require('./vidsrc-resolve.js');

function parseArgs() {
  const args = process.argv.slice(2);
  let type = 'tv';
  let tmdbId = '';
  let season = 1;
  let episode = 1;

  if (args.length === 0) {
    console.error('Usage: node resolve-cli.js <tv|movie> <tmdbId> [season] [episode]');
    console.error('   or: node resolve-cli.js --type=tv --tmdbId=105248 --season=1 --episode=1');
    process.exit(1);
  }

  // Check flag style
  const flagType = args.find(a => a.startsWith('--type='));
  const flagTmdb = args.find(a => a.startsWith('--tmdbId=') || a.startsWith('--id='));
  const flagSeason = args.find(a => a.startsWith('--season=') || a.startsWith('--s='));
  const flagEpisode = args.find(a => a.startsWith('--episode=') || a.startsWith('--e='));

  if (flagType || flagTmdb) {
    if (flagType) type = flagType.split('=')[1];
    if (flagTmdb) tmdbId = flagTmdb.split('=')[1];
    if (flagSeason) season = parseInt(flagSeason.split('=')[1], 10);
    if (flagEpisode) episode = parseInt(flagEpisode.split('=')[1], 10);
  } else {
    // Positional style
    const first = args[0].toLowerCase();
    if (first === 'tv' || first === 'movie') {
      type = first;
      tmdbId = args[1] || '';
      if (args[2]) season = parseInt(args[2], 10);
      if (args[3]) episode = parseInt(args[3], 10);
    } else {
      // Default to tv if first arg is a number
      tmdbId = args[0];
      if (args[1]) season = parseInt(args[1], 10);
      if (args[2]) episode = parseInt(args[2], 10);
    }
  }

  return { type, tmdbId, season, episode };
}

async function main() {
  const params = parseArgs();
  if (!params.tmdbId) {
    console.error(JSON.stringify({ ok: false, step: 'cli_args', error: 'Missing tmdbId parameter' }, null, 2));
    process.exit(1);
  }

  try {
    const result = await resolve(params);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, step: 'cli_execute', error: err.message }, null, 2));
    process.exit(1);
  }
}

main();
