CREATE TABLE material_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 600),
  thumb_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'published' CHECK(status IN ('published','hidden')),
  sort_order integer NOT NULL DEFAULT 0
);
INSERT INTO material_presets(id,name,description,sort_order) VALUES
('60000000-0000-4000-8000-000000000001','粗针','粗针羊毛针织，线圈粗大清晰，表面蓬松厚实。',10),
('60000000-0000-4000-8000-000000000002','罗纹','针织纵向罗纹，凸条与凹槽均匀交替，有弹性。',20),
('60000000-0000-4000-8000-000000000003','绞花','针织线圈交叉形成有起伏的绞花纹理，纹路沿产品走向延伸。',30),
('60000000-0000-4000-8000-000000000004','马海毛','表面覆盖轻盈细长的毛羽，边缘柔和，织物透气蓬松。',40),
('60000000-0000-4000-8000-000000000005','摇粒绒','密集细小的卷曲绒粒，表面柔软哑光，绒面均匀。',50),
('60000000-0000-4000-8000-000000000006','灯芯绒','表面有平行纵向绒条与窄凹槽，顺毛处轻微反光。',60);
