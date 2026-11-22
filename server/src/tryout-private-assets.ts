export const isCompanyLibrarySource=(v:unknown)=>v==="company-model-library"||v==="material-preset-library"||v==="model-preset-library";
export const isTryoutLibrarySource=(v:unknown)=>v==="material-library"||v==="model-library"||isCompanyLibrarySource(v);
export const ordinaryAsset=(alias:string)=>`COALESCE(${alias}.metadata->>'source','') NOT IN ('material-library','material-preset-library','company-model-library','model-library','model-preset-library')`;
export const personalAssetAccess=(alias:string,ownerParam:string)=>`(${alias}.owner_user_id=${ownerParam} OR ${ordinaryAsset(alias)})`;
