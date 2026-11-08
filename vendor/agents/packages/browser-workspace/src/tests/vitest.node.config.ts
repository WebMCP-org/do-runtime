import { alias } from "./alias.ts";

export default {
  resolve: { alias },
  test: {
    name: "browser-workspace",
    include: ["src/tests/*.test.ts"],
    exclude: ["src/tests/*.browser.test.ts"]
  }
};
