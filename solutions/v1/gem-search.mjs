import { planRoute } from './route-search.mjs';

export function planGemRoute(model,native,options={}) {
  return planRoute(model,native,{kind:'gem'},options);
}
