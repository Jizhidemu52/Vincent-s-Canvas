import { expect, test } from "bun:test";
import { nextProjectTitle } from "../src/lib/project-title";

test("new project names remain unique after deletion and with custom project names", () => {
    expect(nextProjectTitle([])).toBe("自由画布 1");
    expect(nextProjectTitle([{ title: "自由画布 1" }, { title: "自由画布 3" }])).toBe("自由画布 2");
    expect(nextProjectTitle([{ title: "自由画布 1" }, { title: "自由画布 2 " }, { title: "私人设计" }])).toBe("自由画布 3");
});

test("new branded defaults preserve existing project titles", () => {
    const projects = [{ title: "无限画布 1" }, { title: "无线画布 2" }, { title: "私人设计" }];
    const original = structuredClone(projects);
    expect(nextProjectTitle(projects)).toBe("自由画布 1");
    expect(projects).toEqual(original);
});
