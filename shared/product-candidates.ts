import { z } from "zod";

export const PRODUCT_CANDIDATES_PROFILE = "product-candidates" as const;
export const PRODUCT_CANDIDATES_TOOL = "report_product_candidates" as const;

/** Semantic product descriptions only; these are not masks or pixel regions. */
export const productCandidateSchema = z.object({
  id: z.string().regex(/^candidate-[1-8]$/),
  name: z.string().trim().min(1).max(60),
  brief: z.string().trim().min(1).max(240),
  evidence: z.string().trim().min(1).max(240),
}).strict();

export const productCandidatesResultSchema = z.object({
  candidates: z.array(productCandidateSchema).max(8),
}).strict().superRefine(({ candidates }, context) => {
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) {
    context.addIssue({ code: "custom", path: ["candidates"], message: "产品候选编号不能重复" });
  }
});

export const productCandidatesContextSchema = z.object({ sourceAssetId: z.string().uuid() }).strict();

export type ProductCandidate = z.infer<typeof productCandidateSchema>;
export type ProductCandidatesReceipt = {
  profile: typeof PRODUCT_CANDIDATES_PROFILE;
  requestId: string;
  sourceAssetId: string;
  status: "processing" | "success" | "failed" | "uncertain";
  candidates?: ProductCandidate[];
  errorCode?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
};
