import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

async function login(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  expect(screen.getByText("登录 Canvas Ops")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "登录" }));
}

describe("Designer canvas app shell", () => {
  it("shows account, history, and project management before opening the canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    expect(screen.getByText("Profile")).toBeInTheDocument();
    expect(screen.getAllByText("Projects").length).toBeGreaterThan(0);
    expect(screen.getAllByText("History").length).toBeGreaterThan(0);
    expect(screen.getByText("Designer credits")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(screen.queryByText("IMAGE")).not.toBeInTheDocument();
    expect(screen.queryByText("Context panel")).not.toBeInTheDocument();
  });

  it("opens the Recraft-like infinite canvas only after a project is created", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));

    expect(screen.getByText("IMAGE")).toBeInTheDocument();
    expect(screen.getByText("Context panel")).toBeInTheDocument();
    expect(screen.getByText("Batch mode")).toBeInTheDocument();
    expect(screen.getByText("Workflow modules")).toBeInTheDocument();
    expect(screen.getByText("fashion-reference.jpg")).toBeInTheDocument();
  });

  it("supports reference uploads, model prompt controls, and right dock panels after entering canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Upload images/i }));

    expect(screen.getByText("reference-front.jpg")).toBeInTheDocument();
    expect(screen.getByText("reference-texture.jpg")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Prompts" }));
    const promptButtons = screen.getAllByRole("button", { name: /局部服装改款/i });
    await user.click(promptButtons[promptButtons.length - 1]);
    expect(screen.getByPlaceholderText(/\[TARGET\]/)).toHaveValue("只修改选区内的服装细节，保持模特姿势、背景、光线和版型不变。");

    await user.click(screen.getByRole("button", { name: "Context" }));
    expect(screen.getByText("Generate node")).toBeInTheDocument();
    expect(screen.getByText("Workflow modules")).toBeInTheDocument();
  });

  it("runs batch mode and writes visible generation history", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByPlaceholderText(/\[TARGET\]/), "统一去背并保持服装边缘清晰");
    await user.click(screen.getByRole("button", { name: "Batch mode" }));
    await user.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getByText(/background-cleaner/i)).toBeInTheDocument();
    expect(screen.getAllByText(/credits/i).length).toBeGreaterThan(0);
  });

  it("opens admin monitoring for an admin session", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: /Admin monitoring/i }));

    expect(screen.getByRole("heading", { name: "Admin monitoring" })).toBeInTheDocument();
    expect(screen.getByText("Model providers")).toBeInTheDocument();
    expect(screen.getByText("Access policy")).toBeInTheDocument();
    expect(screen.getByText("Server only")).toBeInTheDocument();
  });

  it("supports the image node inline model/prompt entry and generation loop", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Inline model" }), "nanobanana2");
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "参考这张图做一件新的刺绣背心");
    const generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);

    expect(screen.getByText("fashion-reference.jpg result 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByText(/nanobanana2/i)).toBeInTheDocument();
    expect(screen.getAllByText(/参考这张图做一件新的刺绣背心/).length).toBeGreaterThan(0);
  });

  it("confirms mask edits, creates target frames, and keeps them visible on canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Edit area/i }));
    expect(screen.getByRole("dialog", { name: "Mask edit confirmation" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "rectangle" }));
    await user.click(screen.getByRole("button", { name: "Confirm edit" }));
    expect(screen.getByText("fashion-reference.jpg mask edit")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Target frame/i }));
    expect(screen.getByText("Generation target frame")).toBeInTheDocument();
    expect(screen.getByText("gpt-image-2-medium")).toBeInTheDocument();
  });

  it("shows generation records and credit usage in the home history and profile views", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "生成一款带盘扣的黑色马甲");
    const generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);
    await user.click(screen.getByRole("button", { name: "Projects" }));

    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("region", { name: "History management" })).toBeInTheDocument();
    expect(screen.getByText(/生成一款带盘扣的黑色马甲/)).toBeInTheDocument();
    expect(screen.getByText("fashion-reference.jpg result 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Profile" }));
    expect(screen.getByRole("region", { name: "Profile credit management" })).toBeInTheDocument();
    expect(screen.getByText("Credit balance")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();
  });
});
