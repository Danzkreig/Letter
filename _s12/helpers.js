/* Quick check of the new mail helpers. */
"use strict";

const path = require("path");
const s = require(path.join(__dirname, "..", "lib", "store.js"));

["parseRecipients", "resolveRecipients", "saveDraft", "getDraft",
 "clearDraft", "quoteFor", "replySubject"].forEach(function (f) {
  console.log("  " + f.padEnd(18) + (typeof s[f] === "function" ? "OK" : "MISSING"));
});

console.log("  MAX_RECIPIENTS: " + s.MAX_RECIPIENTS);
console.log("");
console.log("  parseRecipients('alice, bob; carol, ALICE'):");
console.log("    " + JSON.stringify(s.parseRecipients("alice, bob; carol, ALICE")));
console.log("  parseRecipients(['a', '', '  b  ']):");
console.log("    " + JSON.stringify(s.parseRecipients(["a", "", "  b  "])));
console.log("  parseRecipients(''):");
console.log("    " + JSON.stringify(s.parseRecipients("")));

console.log("");
console.log("  replySubject('Hello'):  " + JSON.stringify(s.replySubject("Hello")));
console.log("  replySubject('Re: Hi'): " + JSON.stringify(s.replySubject("Re: Hi")));
console.log("  replySubject(''):       " + JSON.stringify(s.replySubject("")));

console.log("");
console.log("  quoteFor:");
console.log(JSON.stringify(s.quoteFor({ body: "line one\n\nline two", sent: "2026-01-01T10:00:00Z", fromName: "alice" })));
