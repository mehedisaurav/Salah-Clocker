// Example: a tiny utility that summarizes a directory.
const fs = require("fs");
const path = require("path");

function summarize(dir = ".") {
  const abs = path.resolve(dir);
  const entries = fs.readdirSync(abs).sort();
  console.log(`Directory: ${abs}`);
  console.log(`Time:      ${new Date().toISOString()}`);
  console.log(`Entries:   ${entries.length}`);
  for (const name of entries) {
    const kind = fs.statSync(path.join(abs, name)).isDirectory() ? "dir" : "file";
    console.log(`  - ${name} (${kind})`);
  }
}

summarize();
