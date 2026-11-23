import { addTerrainAsset as addTerrain, addGemAsset as addGem } from "../render/v1/asset-renderers.mjs";

function addModel(add, content, record, dimensions) {
  const first = content.children.length;
  add(content, record, dimensions);
  for (const child of content.children.slice(first)) child.traverse(object => {
    if (object.isMesh) object.userData.truncateModel = true;
  });
}

export const addTerrainAsset = (content, record, dimensions) => addModel(addTerrain, content, record, dimensions);
export const addGemAsset = (content, record, dimensions) => addModel(addGem, content, record, dimensions);
