/* vibecheck-ignore-file CONSOLE_DEBUG */

// This file tests suppression directives

// vibecheck-ignore-next-line TEMPORARY_HACK
// TODO: This should be suppressed
const placeholder = "test";

const data = await fetch("/api/data"); // vibecheck-ignore-line UNSAFE_IO

// Regular code that should still trigger findings
const users = await db.findMany(); // UNBOUNDED_QUERY - not suppressed
console.log("debug"); // CONSOLE_DEBUG - suppressed by file-level directive

// vibecheck-ignore-next-line UNBOUNDED_QUERY,LOOPED_IO
const allItems = await collection.find({});
