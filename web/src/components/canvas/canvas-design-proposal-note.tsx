import type { CanvasNodeData } from "@/types/canvas";

type Proposal = NonNullable<NonNullable<CanvasNodeData["metadata"]>["designProposal"]>;

export default function CanvasDesignProposalNote({ proposal }: { proposal: Proposal }) {
    return <aside className="canvas-design-proposal" data-canvas-no-zoom aria-label="设计方案特色与参考图" onPointerDown={event => event.stopPropagation()}>
        <p>{proposal.features.join(" · ")}</p>
        <div>{proposal.references.map((reference, index) => <figure key={reference.image}>
            <img src={reference.image} alt={reference.title} /><figcaption>图{index + 1} · {reference.title}</figcaption>
        </figure>)}</div>
    </aside>;
}
