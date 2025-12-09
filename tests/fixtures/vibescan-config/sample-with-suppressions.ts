/* vibescan-ignore-file CONSOLE_DEBUG */

// This file tests suppression directives

// vibescan-ignore-next-line TEMPORARY_HACK
// TODO: This should be suppressed
const placeholder = "test";

const data = await fetch("/api/data"); // vibescan-ignore-line UNSAFE_IO

// Regular code that should still trigger findings
const users = await db.findMany(); // UNBOUNDED_QUERY - not suppressed
console.log("debug"); // CONSOLE_DEBUG - suppressed by file-level directive

// vibescan-ignore-next-line UNBOUNDED_QUERY,LOOPED_IO
const allItems = await collection.find({});
