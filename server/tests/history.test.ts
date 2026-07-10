import { describe, expect, test } from "bun:test";

import {
  buildAdminHistoryFilter,
  csvCell,
  parseAdminHistoryQuery,
} from "../src/routes/history";

describe("admin history query contract", () => {
  test("validates pagination and time boundaries", () => {
    expect(
      parseAdminHistoryQuery({
        page: "2",
        pageSize: "100",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-07-31T23:59:59.999Z",
      }),
    ).toMatchObject({
      page: 2,
      pageSize: 100,
    });
    expect(() => parseAdminHistoryQuery({ page: "0" })).toThrow();
    expect(() => parseAdminHistoryQuery({ pageSize: "201" })).toThrow();
    expect(() => parseAdminHistoryQuery({ from: "not-a-date" })).toThrow();
    expect(() =>
      parseAdminHistoryQuery({
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-07-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  test("keeps department scope ahead of user filters", () => {
    const query = parseAdminHistoryQuery({
      userId: "11111111-1111-4111-8111-111111111111",
      projectId: "spring-campaign",
      operationType: "batch_image",
      from: "2026-07-01T00:00:00.000Z",
    });
    const filter = buildAdminHistoryFilter(
      {
        role: "department_admin",
        departmentId: "22222222-2222-4222-8222-222222222222",
      },
      query,
    );

    expect(filter.where).toBe(
      "WHERE h.department_id=$1 AND h.user_id=$2 AND h.project_id=$3 AND h.operation_type=$4 AND h.created_at>=$5::timestamptz",
    );
    expect(filter.values).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      "spring-campaign",
      "batch_image",
      "2026-07-01T00:00:00.000Z",
    ]);
  });

  test("neutralizes spreadsheet formulas in CSV values", () => {
    expect(csvCell('=HYPERLINK("https://example.test")')).toBe(
      '"\'=HYPERLINK(""https://example.test"")"',
    );
    expect(csvCell("normal, value")).toBe('"normal, value"');
    expect(csvCell(new Date("2026-07-10T14:20:00.000Z"))).toBe(
      '"2026-07-10T14:20:00.000Z"',
    );
  });
});
