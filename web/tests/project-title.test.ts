import { expect, test } from "bun:test";
import { nextProjectTitle } from "../src/lib/project-title";

test("new project names remain unique after deletion and with custom project names", () => {
    expect(nextProjectTitle([])).toBe("无限画布 1");
    expect(nextProjectTitle([{ title: "无限画布 1" }, { title: "无限画布 3" }])).toBe("无限画布 2");
    expect(nextProjectTitle([{ title: "无限画布 1" }, { title: "无限画布 2 " }, { title: "私人设计" }])).toBe("无限画布 3");
});
