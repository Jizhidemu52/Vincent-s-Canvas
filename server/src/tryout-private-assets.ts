export const isCompanyLibrarySource=(v:unknown)=>v==="company-model-library"||v==="material-preset-library"||v==="model-preset-library";
export const isTryoutLibrarySource=(v:unknown)=>v==="material-library"||v==="model-library"||isCompanyLibrarySource(v);
export const ordinaryAsset=(alias:string)=>`COALESCE(${alias}.metadata->>'source','') NOT IN ('material-library','material-preset-library','company-model-library','model-library','model-preset-library')`;
export const fabricPhotoAccess="a.kind='image' AND a.status='ready' AND a.deleted_at IS NULL AND (a.metadata->>'source'='material-preset-library' OR (a.visibility_scope='company' AND "+ordinaryAsset("a")+"))";
export const publishedFabric=(param:string)=>`EXISTS(SELECT 1 FROM material_presets p WHERE p.id=${param} AND p.status='published' AND p.thumb_asset_id=a.id AND ${fabricPhotoAccess})`;
export const personalAssetAccess=(alias:string,ownerParam:string)=>`(${alias}.owner_user_id=${ownerParam} OR ${ordinaryAsset(alias)})`;
