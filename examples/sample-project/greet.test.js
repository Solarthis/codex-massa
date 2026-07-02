// Verification command for the sample project: `node greet.test.js`
// Exits non-zero (fails verification) until src/greet.js is correct.
import assert from 'node:assert';
import { greet } from './src/greet.js';

assert.strictEqual(
  greet('World'),
  'Hello, World!',
  `expected "Hello, World!" but got "${greet('World')}"`,
);
console.log('ok - greet returns the exact required greeting');
