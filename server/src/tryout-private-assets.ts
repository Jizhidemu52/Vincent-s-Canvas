export const isTryoutLibrarySource=(v:unknown)=>v==="material-library"||v==="model-library"||v==="model-preset-library";
export const ordinaryAsset=(alias:string)=>`COALESCE(${alias}.metadata->>'source','') NOT IN ('material-library','model-library','model-preset-library')`;
export const personalAssetAccess=(alias:string,ownerParam:string)=>`(${alias}.owner_user_id=${ownerParam} OR ${ordinaryAsset(alias)})`;
