'use strict';

const pkg = require('../package.json');
const refType = String(process.env.GITHUB_REF_TYPE || '');
const refName = String(process.env.GITHUB_REF_NAME || '');
const expected = `v${pkg.version}`;

if (refType === 'tag' && refName !== expected) {
  console.error(`Release tag ${refName} does not match package version ${pkg.version}. Expected ${expected}.`);
  process.exit(1);
}
console.log(refType === 'tag' ? `Release version verified: ${expected}` : `Manual release for package version ${pkg.version}`);
