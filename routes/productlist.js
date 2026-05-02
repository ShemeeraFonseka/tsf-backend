// routes/productlist.js — MASTER CATALOGUE
// Products are type-agnostic. variants only carry: { id, size, unit, purchasing_price }
// Local/sea/air pricing live in separate tables.
import express from "express";
import supabase from "../db.js";
import multer from "multer";
import path from "path";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });
const sf = (v, d = 0) => (isFinite(parseFloat(v)) ? parseFloat(v) : d);

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

// ═══════════════════════════════════════════════════════════════
// GET /api/productlist  — all products (master catalogue)
// ═══════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("common_name");
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

// ═══════════════════════════════════════════════════════════════
// POST /api/productlist/upload  — create product
// ═══════════════════════════════════════════════════════════════
router.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const {
      common_name,
      scientific_name,
      description,
      species_type,
      variants,
    } = req.body;
    const image_url = req.file ? await uploadImage(req.file) : null;
    const rawVariants = JSON.parse(
      typeof variants === "string" ? variants : JSON.stringify(variants || []),
    );

    // Strip variants to base fields only
    const cleanVariants = rawVariants
      .map((v) => ({
        id: v.id || Date.now(),
        size: v.size || "",
        unit: v.unit || "kg",
        purchasing_price: sf(v.purchasing_price),
      }))
      .filter((v) => (v.size || "").trim());

    const { data, error } = await supabase
      .from("products")
      .insert({
        common_name,
        scientific_name,
        description,
        species_type,
        image_url,
        variants: cleanVariants,
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

// ═══════════════════════════════════════════════════════════════
// PUT /api/productlist/upload/:id  — update product
// ═══════════════════════════════════════════════════════════════
router.put("/upload/:id", upload.single("image"), async (req, res) => {
  try {
    const {
      common_name,
      scientific_name,
      description,
      species_type,
      existing_image_url,
      variants,
    } = req.body;
    const image_url = req.file
      ? await uploadImage(req.file)
      : existing_image_url;
    const rawVariants = JSON.parse(
      typeof variants === "string" ? variants : JSON.stringify(variants || []),
    );

    // Strip to base fields only
    const cleanVariants = rawVariants
      .map((v) => ({
        id: v.id || Date.now(),
        size: v.size || "",
        unit: v.unit || "kg",
        purchasing_price: sf(v.purchasing_price),
      }))
      .filter((v) => (v.size || "").trim());

    // Fetch old data for cascade checks
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
        species_type,
        image_url,
        variants: cleanVariants,
      })
      .eq("id", req.params.id);
    if (error) throw error;

    // ── Cascade purchasing_price changes ───────────────────────
    if (old?.variants) {
      for (const nv of cleanVariants) {
        const ov = old.variants.find((v) => String(v.id) === String(nv.id));
        if (!ov) continue;
        const ppChanged =
          Math.abs(sf(ov.purchasing_price) - sf(nv.purchasing_price)) > 0.001;
        if (!ppChanged) continue;

        // 1. Cascade to local_product_prices (update purchasing_price reference)
        //    → then recalc customer_product selling_price
        await cascadeLocalPurchasePrice(
          req.params.id,
          nv.id,
          sf(nv.purchasing_price),
        );

        // 2. Cascade to export customer tables
        await cascadeExportPurchasePrice(
          "exportcustomer_product",
          req.params.id,
          nv.id,
          sf(nv.purchasing_price),
        );
        await cascadeExportPurchasePrice(
          "exportcustomer_productair",
          req.params.id,
          nv.id,
          sf(nv.purchasing_price),
        );
      }
    }

    // ── Cascade image change ───────────────────────────────────
    if (old?.image_url && old.image_url !== image_url) {
      await supabase
        .from("exportcustomer_product")
        .update({ image_url })
        .eq("product_id", req.params.id);
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

// ═══════════════════════════════════════════════════════════════
// DELETE /api/productlist/:id
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// VARIANT ROUTES  (base info only — no pricing)
// ═══════════════════════════════════════════════════════════════

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
      .select("variants")
      .eq("id", productId)
      .single();
    if (fe) throw fe;

    const variants = Array.isArray(prod.variants) ? prod.variants : [];
    const newVar = {
      id: Date.now(),
      size: req.body.size || "",
      unit: req.body.unit || "kg",
      purchasing_price: sf(req.body.purchasing_price),
    };

    const { error } = await supabase
      .from("products")
      .update({ variants: [...variants, newVar] })
      .eq("id", productId);
    if (error) throw error;
    res.status(201).json(newVar);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:productId/variants/:variantId", async (req, res) => {
  const { productId, variantId } = req.params;
  try {
    const { data: prod, error: fe } = await supabase
      .from("products")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fe) throw fe;

    const variants = Array.isArray(prod.variants) ? prod.variants : [];
    const old = variants.find((v) => String(v.id) === String(variantId));
    const newPP = sf(req.body.purchasing_price);

    const updated = variants.map((v) =>
      String(v.id) === String(variantId)
        ? {
            ...v,
            size: req.body.size || v.size,
            unit: req.body.unit || v.unit,
            purchasing_price: newPP,
          }
        : v,
    );

    const { error } = await supabase
      .from("products")
      .update({ variants: updated })
      .eq("id", productId);
    if (error) throw error;

    // Cascade if purchasing_price changed
    if (old && Math.abs(sf(old.purchasing_price) - newPP) > 0.001) {
      await cascadeLocalPurchasePrice(productId, variantId, newPP);
      await cascadeExportPurchasePrice(
        "exportcustomer_product",
        productId,
        variantId,
        newPP,
      );
      await cascadeExportPurchasePrice(
        "exportcustomer_productair",
        productId,
        variantId,
        newPP,
      );
    }

    res.json(updated.find((v) => String(v.id) === String(variantId)));
  } catch (err) {
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

// When purchasing_price changes on master product:
// → update purchasing_price in customer_product and recalc selling_price
async function cascadeLocalPurchasePrice(productId, variantId, newPP) {
  try {
    // 1. Update local_product_prices — keep profit fixed, recalc selling_price
    let lpq = supabase
      .from("local_product_prices")
      .select("id, profit, profit_margin_percentage")
      .eq("product_id", productId);
    if (variantId)
      lpq = lpq.eq("variant_id", Math.floor(parseFloat(variantId)));
    const { data: lpRows } = await lpq;

    for (const lp of lpRows || []) {
      const profit = sf(lp.profit);
      const sp = newPP + profit;
      const pmp = sp > 0 ? (profit / sp) * 100 : 0;
      await supabase
        .from("local_product_prices")
        .update({
          selling_price: parseFloat(sp.toFixed(2)),
          profit_margin_percentage: parseFloat(pmp.toFixed(4)),
          updated_at: new Date().toISOString(),
        })
        .eq("id", lp.id);
    }

    // 2. Update customer_product — keep margin fixed, recalc selling_price
    let q = supabase
      .from("customer_product")
      .select("id, margin")
      .eq("product_id", productId);
    if (variantId) q = q.eq("variant_id", variantId);
    const { data: rows } = await q;
    for (const cp of rows || []) {
      const margin = sf(cp.margin);
      const sp = newPP + margin;
      const pmp = sp > 0 ? (margin / sp) * 100 : 0;
      await supabase
        .from("customer_product")
        .update({
          purchasing_price: newPP,
          selling_price: parseFloat(sp.toFixed(2)),
          margin_percentage: parseFloat(pmp.toFixed(4)),
        })
        .eq("id", cp.id);
    }
  } catch (err) {
    console.error("[cascadeLocalPurchasePrice]", err.message);
  }
}

// When purchasing_price changes: update it in export customer tables
async function cascadeExportPurchasePrice(table, productId, variantId, newPP) {
  try {
    let q = supabase.from(table).select("id").eq("product_id", productId);
    if (variantId) q = q.eq("variant_id", variantId);
    const { data: rows } = await q;
    for (const cp of rows || []) {
      await supabase
        .from(table)
        .update({ purchasing_price: newPP })
        .eq("id", cp.id);
    }
  } catch (err) {
    console.error(`[cascadeExportPurchasePrice:${table}]`, err.message);
  }
}

export default router;
