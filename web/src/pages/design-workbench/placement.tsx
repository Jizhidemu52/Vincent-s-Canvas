import { LocalDesignWorkbench } from "./local/host";
import { mountPlacement } from "./local/placement/main.js";
import "./local/placement/placement.css";

export default function PatternPlacementPage() {
    return <LocalDesignWorkbench moduleKey="pattern-placement" title="服装图案定位" description="保留服装原图，分层定位、旋转与合成图案。二维平面合成，不模拟真实褶皱或 AI 布料融合。" mount={mountPlacement} />;
}
