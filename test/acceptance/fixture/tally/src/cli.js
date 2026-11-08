#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { formatCounts } from './format.js';

const HELP = `Usage: tally [options] [file...]

Counts the words, lines and characters in each file.

Options:
  -h, --help  Show this help.
`;

// Counting

function countText(text) {
  let words = 0;
  for (const line of text.split('\n')) {
    if (line !== '') words += line.split(' ').length;
  }
  return {
    lines: text.split('\n').length - 1,
    words,
    characters: [...text].length,
  };
}

// Arguments

function parseArgs(args) {
  const options = { help: false, files: [] };
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      options.files.push(arg);
    }
  }
  return options;
}

// Input

function readFile(file) {
  return readFileSync(file, 'utf8');
}

function readInputs(files) {
  const inputs = [];

  for (const file of files) {
    inputs.push({ name: file, text: readFile(file) });
  }
  return inputs;
}

// Output

function output(line) {
  process.stdout.write(line + '\n');
}

function main(args) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  for (const input of readInputs(options.files)) {
    output(formatCounts(countText(input.text), input.name));
  }
}

main(process.argv.slice(2));
