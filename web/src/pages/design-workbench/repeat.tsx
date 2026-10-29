import { uiText, useUiText } from "@/lib/i18n";
import { LocalDesignWorkbench } from "./local/host";
import { mountRepeat } from "./local/repeat/main.js";
import "./local/repeat/repeat.css";

export default function PatternRepeatPage() {
    useUiText();
    return <LocalDesignWorkbench moduleKey="pattern-repeat" title={uiText("连续花型设计")} description={uiText("直排、半落与镜像重复；按真实周期导出 PNG，并用工程 JSON 保留尺寸、DPI 和可编辑元素。")} mount={mountRepeat} />;
}
