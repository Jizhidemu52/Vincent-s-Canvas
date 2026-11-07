// Source-only export: never load application configuration, DB or legacy recipes.
import { newCreativeRecipes, newCreativeRecipeContent } from "../../server/src/new-creative-recipes";
import { promptHash } from "../../server/src/prompt-recipe-store";
import { promptRecipeVersionSchema } from "../../shared/prompt-contracts";

console.log(JSON.stringify(newCreativeRecipes.map(({ key, name, systemPrompt }) => {
  const content = promptRecipeVersionSchema.parse(newCreativeRecipeContent(systemPrompt));
  return { key, name, content, contentHash: promptHash(content) };
})));
