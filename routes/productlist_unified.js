// routes/productlist.js — UNIFIED
// Replaces: productlist.js + exportproductlist.js + exportproductlistair.js
// Query param: ?type=local | export_sea | export_air | all
import express from "express";
import supabase from "../db.js";
import multer from "multer";
import path from "path";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

const sf = (v, def = 0) => (isFinite(parseFloat(v)) ? parseFloat(v) : def);

// ── image upload helper ────────────────────────────────────────
async function uploadImage(file) {
  const fileName = `${Date.now()}${path.extname(file.originalname)}`;
  const { error } = await supabase.storage
    .from("product-images")
    .upload(fileName, file.buffer, { contentType: file.mimetype });
  if (error) throw error;
  const {
    data: { publicUrl },
  } = supabase.storage.from("product-images").getPublicUrl(fileName);
  return publicUrl;
}

// ── variant builder ────────────────────────────────────────────
// Builds a full variant object from form body.
// For export variants, profit can be entered as LKR or USD.
// Both profit_lkr and profit_usd are always stored.
function buildVariant(body, types, existing = null) {
  const id = existing?.id || Date.now();
  const { size, unit } = body;
  const variant = { id, size: size || "", unit: unit || "kg" };

  // ── LOCAL fields ──
  if (types.includes("local")) {
    const pp = sf(body.purchasing_price);
    const pr = sf(body.profit);
    const sp = sf(body.selling_price) || pp + pr;
    const pmp =
      sf(body.profit_margin_percentage) || (sp > 0 ? (pr / sp) * 100 : 0);
    Object.assign(variant, {
      purchasing_price: pp,
      profit: pr,
      selling_price: parseFloat(sp.toFixed(2)),
      profit_margin_percentage: parseFloat(pmp.toFixed(4)),
    });
  }

  // ── EXPORT fields (sea and/or air — identical structure) ──
  if (types.includes("export_sea") || types.includes("export_air")) {
    const usdRate = sf(body.usdrate, 304);
    const jcFob = sf(body.jc_fob);
    const labour = sf(body.labour_overhead);
    const packing = sf(body.packing_cost);
    const multVal = sf(body.multiplier);
    const divVal = sf(body.divisor, 1);
    const ppExport = sf(body.export_purchasing_price || body.purchasing_price);

    // ── Profit: admin enters either LKR or USD, we store both ──
    const profitCurrency = body.profit_currency || "usd"; // "lkr" or "usd"
    let profitUSD = 0;
    let profitLKR = 0;

    if (profitCurrency === "lkr") {
      profitLKR = sf(body.profit_lkr || body.profit_export);
      profitUSD = usdRate > 0 ? profitLKR / usdRate : 0;
    } else {
      profitUSD = sf(body.profit_usd || body.profit_export);
      profitLKR = profitUSD * usdRate;
    }

    // ── Ex-factory price calculation ──
    // Model 1: purchase price based
    //   exfactory = purchasing_price + (labour + packing + profitUSD) * usdRate
    // Model 2: JC FOB based
    //   exfactory = (jc_fob + labour + packing + profitUSD) * usdRate
    let exFactory = sf(body.exfactoryprice); // if provided directly
    let fobUSD = 0;
    let profitMargin = sf(body.profit_margin);

    if (!exFactory) {
      if (ppExport > 0) {
        // Model 1
        const totalUSD = labour + packing + profitUSD;
        exFactory = ppExport + totalUSD * usdRate;
        fobUSD = exFactory / usdRate;
      } else if (jcFob > 0) {
        // Model 2
        const totalUSD = jcFob + profitUSD + packing + labour;
        exFactory = totalUSD * usdRate;
        fobUSD = totalUSD;
      }
      profitMargin = fobUSD > 0 ? (profitUSD / fobUSD) * 100 : 0;
    }

    Object.assign(variant, {
      export_purchasing_price: ppExport,
      jc_fob: jcFob,
      usdrate: usdRate,
      labour_overhead: labour,
      packing_cost: packing,
      profit_usd: parseFloat(profitUSD.toFixed(4)),
      profit_lkr: parseFloat(profitLKR.toFixed(2)),
      profit_currency: profitCurrency,
      profit_margin: parseFloat(profitMargin.toFixed(4)),
      exfactoryprice: parseFloat(exFactory.toFixed(2)),
      multiplier: multVal,
      divisor: divVal,
    });
  }

  return variant;
}

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/productlist?type=local|export_sea|export_air|all
router.get("/", async (req, res) => {
  const { type = "local" } = req.query;
  try {
    let q = supabase.from("products").select("*").order("common_name");
    if (type !== "all") q = q.contains("product_types", [type]);
    const { data, error } = await q;
    if (error) throw error;
    const result = (data || []).map((p) => ({
      ...p,
      variants: Array.isArray(p.variants)
        ? [...p.variants].sort(
            (a, b) =>
              sf(a.purchasing_price, 9999) - sf(b.purchasing_price, 9999),
          )
        : [],
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/productlist/:id
router.get("/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (error)
      return res
        .status(error.code === "PGRST116" ? 404 : 500)
        .json({ error: error.message });
    if (!Array.isArray(data.variants)) data.variants = [];
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/productlist/upload
router.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const {
      common_name,
      scientific_name,
      description,
      category,
      species_type,
      product_types,
      variants,
    } = req.body;
    const image_url = req.file ? await uploadImage(req.file) : null;
    const typesData = JSON.parse(product_types || '["local"]');
    const variantsData = JSON.parse(
      typeof variants === "string" ? variants : JSON.stringify(variants || []),
    );

    const { data, error } = await supabase
      .from("products")
      .insert({
        common_name,
        scientific_name,
        description,
        category,
        species_type,
        image_url,
        product_types: typesData,
        variants: variantsData,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/productlist/upload/:id
router.put("/upload/:id", upload.single("image"), async (req, res) => {
  try {
    const {
      common_name,
      scientific_name,
      description,
      category,
      species_type,
      existing_image_url,
      product_types,
      variants,
    } = req.body;
    const image_url = req.file
      ? await uploadImage(req.file)
      : existing_image_url;
    const typesData = JSON.parse(product_types || '["local"]');
    const variantsData = JSON.parse(
      typeof variants === "string" ? variants : JSON.stringify(variants || []),
    );

    const { data: old } = await supabase
      .from("products")
      .select("variants, image_url")
      .eq("id", req.params.id)
      .single();

    const { error } = await supabase
      .from("products")
      .update({
        common_name,
        scientific_name,
        description,
        category,
        species_type,
        image_url,
        product_types: typesData,
        variants: variantsData,
      })
      .eq("id", req.params.id);
    if (error) throw error;

    // cascade price changes
    if (old?.variants) {
      for (const nv of variantsData) {
        const ov = old.variants.find((v) => v.id === nv.id);
        if (!ov) continue;

        if (typesData.includes("local")) {
          const ppChanged =
            Math.abs(sf(ov.purchasing_price) - sf(nv.purchasing_price)) > 0.001;
          const prChanged = Math.abs(sf(ov.profit) - sf(nv.profit)) > 0.001;
          if (ppChanged || prChanged)
            await cascadeLocal(
              req.params.id,
              nv.id,
              sf(nv.purchasing_price),
              sf(nv.profit),
              prChanged,
            );
        }
        if (typesData.includes("export_sea")) {
          if (Math.abs(sf(ov.exfactoryprice) - sf(nv.exfactoryprice)) > 0.001)
            await cascadeExport(
              "exportcustomer_product",
              req.params.id,
              nv.id,
              sf(nv.exfactoryprice),
              sf(nv.export_purchasing_price || nv.purchasing_price),
            );
        }
        if (typesData.includes("export_air")) {
          if (Math.abs(sf(ov.exfactoryprice) - sf(nv.exfactoryprice)) > 0.001)
            await cascadeExport(
              "exportcustomer_productair",
              req.params.id,
              nv.id,
              sf(nv.exfactoryprice),
              sf(nv.export_purchasing_price || nv.purchasing_price),
            );
        }
      }
    }

    // cascade image update to customer tables
    if (old?.image_url && old.image_url !== image_url) {
      if (typesData.includes("export_sea"))
        await supabase
          .from("exportcustomer_product")
          .update({ image_url })
          .eq("product_id", req.params.id);
      if (typesData.includes("export_air"))
        await supabase
          .from("exportcustomer_productair")
          .update({ image_url })
          .eq("product_id", req.params.id);
    }

    const { data: updated } = await supabase
      .from("products")
      .select("*")
      .eq("id", req.params.id)
      .single();
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/productlist/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ message: "Product deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── VARIANT ROUTES ─────────────────────────────────────────────

router.get("/:productId/variants", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("variants")
      .eq("id", req.params.productId)
      .single();
    if (error) throw error;
    res.json(data.variants || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:productId/variants", async (req, res) => {
  const { productId } = req.params;
  try {
    const { data: prod, error: fe } = await supabase
      .from("products")
      .select("variants, product_types")
      .eq("id", productId)
      .single();
    if (fe) throw fe;
    const variants = Array.isArray(prod.variants) ? prod.variants : [];
    const newVar = buildVariant(req.body, prod.product_types || ["local"]);
    const { error } = await supabase
      .from("products")
      .update({ variants: [...variants, newVar] })
      .eq("id", productId);
    if (error) throw error;
    res.status(201).json(newVar);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.put("/:productId/variants/:variantId", async (req, res) => {
  const { productId, variantId } = req.params;
  try {
    const { data: prod, error: fe } = await supabase
      .from("products")
      .select("variants, product_types")
      .eq("id", productId)
      .single();
    if (fe) throw fe;
    const types = prod.product_types || ["local"];
    const variants = Array.isArray(prod.variants) ? prod.variants : [];
    const old = variants.find((v) => String(v.id) === String(variantId));
    const newVar = buildVariant(req.body, types, old);
    const updated = variants.map((v) =>
      String(v.id) === String(variantId) ? { ...old, ...newVar } : v,
    );

    const { error } = await supabase
      .from("products")
      .update({ variants: updated })
      .eq("id", productId);
    if (error) throw error;

    if (old) {
      if (types.includes("local")) {
        const ppCh =
          Math.abs(sf(old.purchasing_price) - sf(newVar.purchasing_price)) >
          0.001;
        const prCh = Math.abs(sf(old.profit) - sf(newVar.profit)) > 0.001;
        if (ppCh || prCh)
          await cascadeLocal(
            productId,
            variantId,
            sf(newVar.purchasing_price),
            sf(newVar.profit),
            prCh,
          );
      }
      if (
        types.includes("export_sea") &&
        Math.abs(sf(old.exfactoryprice) - sf(newVar.exfactoryprice)) > 0.001
      )
        await cascadeExport(
          "exportcustomer_product",
          productId,
          variantId,
          sf(newVar.exfactoryprice),
          sf(newVar.export_purchasing_price),
        );
      if (
        types.includes("export_air") &&
        Math.abs(sf(old.exfactoryprice) - sf(newVar.exfactoryprice)) > 0.001
      )
        await cascadeExport(
          "exportcustomer_productair",
          productId,
          variantId,
          sf(newVar.exfactoryprice),
          sf(newVar.export_purchasing_price),
        );
    }

    res.json(updated.find((v) => String(v.id) === String(variantId)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:productId/variants/:variantId", async (req, res) => {
  const { productId, variantId } = req.params;
  try {
    const { data: prod, error: fe } = await supabase
      .from("products")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fe) throw fe;
    const updated = (prod.variants || []).filter(
      (v) => String(v.id) !== String(variantId),
    );
    const { error } = await supabase
      .from("products")
      .update({ variants: updated })
      .eq("id", productId);
    if (error) throw error;
    res.json({ message: "Variant deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// CASCADE HELPERS
// ═══════════════════════════════════════════════════════════════

async function cascadeLocal(
  productId,
  variantId,
  newPP,
  newProfit,
  profitChanged,
) {
  const { data: rows } = await supabase
    .from("customer_product")
    .select("id, margin, purchasing_price")
    .eq("product_id", productId)
    .eq("variant_id", variantId);

  for (const cp of rows || []) {
    let payload;
    if (profitChanged) {
      const sp = sf(cp.purchasing_price) + newProfit;
      const pmp = sp > 0 ? (newProfit / sp) * 100 : 0;
      payload = {
        margin: newProfit,
        selling_price: parseFloat(sp.toFixed(2)),
        margin_percentage: parseFloat(pmp.toFixed(4)),
      };
    } else {
      const m = sf(cp.margin);
      const sp = newPP + m;
      const pmp = sp > 0 ? (m / sp) * 100 : 0;
      payload = {
        purchasing_price: newPP,
        selling_price: parseFloat(sp.toFixed(2)),
        margin_percentage: parseFloat(pmp.toFixed(4)),
      };
    }
    await supabase.from("customer_product").update(payload).eq("id", cp.id);
  }
}

async function cascadeExport(table, productId, variantId, newExFactory, newPP) {
  const { data: usdRow } = await supabase
    .from("usd_rates")
    .select("rate")
    .order("date", { ascending: false })
    .limit(1)
    .single();
  const usdRate = sf(usdRow?.rate, 304);
  const isAir = table === "exportcustomer_productair";

  const { data: rows } = await supabase
    .from(table)
    .select("*")
    .eq("product_id", productId)
    .eq("variant_id", variantId);

  for (const cp of rows || []) {
    const additionalUSD = [
      "export_doc",
      "transport_cost",
      "loading_cost",
      "airway_cost",
      "forwardHandling_cost",
    ].reduce((s, k) => s + sf(cp[k]), 0);

    // air stores FOB as USD; sea stores FOB as LKR
    const fobUSD = isAir
      ? newExFactory / usdRate + additionalUSD
      : (newExFactory + additionalUSD * usdRate) / usdRate;

    const payload = {
      purchasing_price: newPP,
      exfactoryprice: parseFloat(newExFactory.toFixed(2)),
      fob_price: isAir
        ? parseFloat(fobUSD.toFixed(4))
        : parseFloat((fobUSD * usdRate).toFixed(2)),
    };

    if (isAir) {
      payload.cnf_45kg = parseFloat(
        (fobUSD + sf(cp.freight_cost_45kg)).toFixed(2),
      );
      payload.cnf_100kg = parseFloat(
        (fobUSD + sf(cp.freight_cost_100kg)).toFixed(2),
      );
      payload.cnf_300kg = parseFloat(
        (fobUSD + sf(cp.freight_cost_300kg)).toFixed(2),
      );
      payload.cnf_500kg = parseFloat(
        (fobUSD + sf(cp.freight_cost_500kg)).toFixed(2),
      );
    } else {
      payload.cnf_45kg = parseFloat(
        (fobUSD + sf(cp.freight_cost_45kg)).toFixed(2),
      );
      payload.cnf_100kg = parseFloat(
        (fobUSD + sf(cp.freight_cost_100kg)).toFixed(2),
      );
      payload.cnf_300kg = parseFloat(
        (fobUSD + sf(cp.freight_cost_300kg)).toFixed(2),
      );
      payload.cnf_500kg = parseFloat(
        (fobUSD + sf(cp.freight_cost_500kg)).toFixed(2),
      );
      payload.cnf_20ft = parseFloat(
        (fobUSD + sf(cp.freight_cost_20ft)).toFixed(2),
      );
      payload.cnf_40ft = parseFloat(
        (fobUSD + sf(cp.freight_cost_40ft)).toFixed(2),
      );
    }

    await supabase.from(table).update(payload).eq("id", cp.id);
  }
}

export default router;
