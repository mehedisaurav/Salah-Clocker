/* Tiny static server for manually previewing the extension's pages. */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = 8123;
const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let file = path.join(ROOT, urlPath === "/" ? "popup.html" : urlPath);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found: " + urlPath);
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      });
      res.end(data);
    });
  })
  .listen(PORT, "127.0.0.1", () =>
    console.log("serving " + ROOT + " at http://127.0.0.1:" + PORT + "/popup.html")
  );
