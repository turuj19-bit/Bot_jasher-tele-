// Split loader for the original server.js
// The parts are executed in the exact original order inside one shared Node VM context.
// This keeps the original runtime behavior and avoids changing business logic.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const shared = {
  console, process, Buffer, URL,
  require,
  __dirname, __filename,
  setTimeout, clearTimeout, setInterval, clearInterval,
  setImmediate, clearImmediate,
};

const context = vm.createContext(shared);

const parts = [
  "core/bootstrap.js",
  "core/helpers.js",
  "core/authui.js",
  "core/accounts.js",
  "core/telegram.js",
  "core/groups.js",
  "features/promotions.js",
  "features/login.js",
  "features/migrations.js",
  "features/handlers.js",
  "features/startup.js",
];

for (const file of parts) {
  const filename = path.join(__dirname, file);
  const code = fs.readFileSync(filename, "utf8");
  vm.runInContext(code, context, { filename });
}
