import express from "express";
import supabase from "../db.js";
import multer from "multer";
import { extname } from "path";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });
const sf = (v, d = 0) => (isFinite(parseFloat(v)) ? parseFloat(v) : d);

async function uploadImage(file) {
  const fileName = `${Date.now()}${extname(file.originalname)}`;
  const { error } = await supabase.storage
    .from("product-images")
    .upload(fileName, file.buffer, { contentType: file.mimetype });
  if (error) throw error;
  const {
    data: { publicUrl },
  } = supabase.storage.from("product-images").getPublicUrl(fileName);
  return publicUrl;
}

// GET all
router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("exportproducts")
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

// GET by id
router.get("/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("exportproducts")
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

// POST /upload
router.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const {
      common_name,
      scientific_name,
      description,
      category,
      species_type,
      variants,
      product_id,
    } = req.body;
    const image_url = req.file
      ? await uploadImage(req.file)
      : req.body.image_url_direct || null;
    let variantsData = [];
    try {
      variantsData =
        typeof variants === "string" ? JSON.parse(variants) : variants || [];
      if (!Array.isArray(variantsData)) variantsData = [];
    } catch {
      variantsData = [];
    }
    const { data, error } = await supabase
      .from("exportproducts")
      .insert({
        common_name,
        scientific_name,
        description,
        category,
        species_type,
        image_url: image_url || null,
        variants: variantsData,
        product_id: product_id ? parseInt(product_id) : null,
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

// PUT /upload/:id
router.put("/upload/:id", upload.single("image"), async (req, res) => {
  try {
    const {
      common_name,
      scientific_name,
      description,
      category,
      species_type,
      existing_image_url,
      variants,
      product_id,
    } = req.body;
    const image_url = req.file
      ? await uploadImage(req.file)
      : existing_image_url || req.body.image_url_direct || null;

    const { data: current, error: fetchErr } = await supabase
      .from("exportproducts")
      .select("variants, image_url")
      .eq("id", req.params.id)
      .single();
    if (fetchErr) throw fetchErr;

    let variantsData = [];
    try {
      variantsData =
        typeof variants === "string" ? JSON.parse(variants) : variants || [];
      if (!Array.isArray(variantsData)) variantsData = [];
    } catch {
      variantsData = [];
    }

    const parsedProductId = product_id ? parseInt(product_id) : null;
    const shouldSetProductId =
      parsedProductId && parsedProductId !== parseInt(req.params.id);

    const { error: updateErr } = await supabase
      .from("exportproducts")
      .update({
        common_name,
        scientific_name,
        description,
        category,
        species_type,
        image_url: image_url || null,
        variants: variantsData,
        ...(shouldSetProductId ? { product_id: parsedProductId } : {}),
      })
      .eq("id", req.params.id);
    if (updateErr) throw updateErr;

    // Image cascade
    if (image_url && current.image_url !== image_url) {
      await updateCustomerImage(req.params.id, image_url);
    }

    // Pricing cascade — always cascade on PUT
    for (const nv of variantsData) {
      if (sf(nv.exfactoryprice) > 0) {
        await cascadeCustomerPrices(
          req.params.id,
          nv.id,
          sf(nv.exfactoryprice),
          sf(nv.purchasing_price),
        );
      }
    }

    const { data: updated } = await supabase
      .from("exportproducts")
      .select("*")
      .eq("id", req.params.id)
      .single();
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("exportproducts")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ message: "Product deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Variant routes
router.get("/:productId/variants", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("exportproducts")
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
      .from("exportproducts")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fe) throw fe;
    const variants = Array.isArray(prod.variants) ? prod.variants : [];
    const newVar = buildVariant(req.body);
    const { error } = await supabase
      .from("exportproducts")
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
      .from("exportproducts")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fe) throw fe;
    const variants = Array.isArray(prod.variants) ? prod.variants : [];
    const old = variants.find((v) => v.id == variantId);
    const newVar = buildVariant(req.body, old);
    const updated = variants.map((v) =>
      v.id == variantId ? { ...old, ...newVar } : v,
    );
    const { error } = await supabase
      .from("exportproducts")
      .update({ variants: updated })
      .eq("id", productId);
    if (error) throw error;
    await cascadeCustomerPrices(
      productId,
      variantId,
      sf(newVar.exfactoryprice),
      sf(newVar.purchasing_price),
    );
    res.json(updated.find((v) => v.id == variantId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:productId/variants/:variantId", async (req, res) => {
  const { productId, variantId } = req.params;
  try {
    const { data: prod, error: fe } = await supabase
      .from("exportproducts")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fe) throw fe;
    const updated = (prod.variants || []).filter((v) => v.id != variantId);
    const { error } = await supabase
      .from("exportproducts")
      .update({ variants: updated })
      .eq("id", productId);
    if (error) throw error;
    res.json({ message: "Variant deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ──
function buildVariant(body, existing = null) {
  const id = existing?.id || Date.now();
  const usdRateVal = sf(body.usdrate, 304);
  const hasPP = sf(body.purchasing_price) > 0;
  const hasJCF = sf(body.jc_fob) > 0;

  let exFactory = 0,
    fobUSD = 0,
    profitMargin = 0;
  if (hasPP) {
    const totalUSD =
      sf(body.labour_overhead) + sf(body.packing_cost) + sf(body.profit);
    exFactory = sf(body.purchasing_price) + totalUSD * usdRateVal;
    fobUSD = usdRateVal > 0 ? exFactory / usdRateVal : 0;
    profitMargin = fobUSD > 0 ? (sf(body.profit) / fobUSD) * 100 : 0;
  } else if (hasJCF) {
    const totalUSD =
      sf(body.jc_fob) +
      sf(body.profit) +
      sf(body.packing_cost) +
      sf(body.labour_overhead);
    exFactory = totalUSD * usdRateVal;
    fobUSD = totalUSD;
    profitMargin = fobUSD > 0 ? (sf(body.profit) / fobUSD) * 100 : 0;
  }

  return {
    id,
    size: body.size || existing?.size || "",
    unit: body.unit || existing?.unit || "kg",
    purchasing_price: hasPP ? sf(body.purchasing_price) : 0,
    jc_fob: hasJCF ? sf(body.jc_fob) : 0,
    usdrate: usdRateVal,
    labour_overhead: sf(body.labour_overhead),
    packing_cost: sf(body.packing_cost),
    profit: sf(body.profit),
    profit_margin: parseFloat(profitMargin.toFixed(4)),
    exfactoryprice: parseFloat(exFactory.toFixed(2)),
    multiplier: sf(body.multiplier),
    divisor: sf(body.divisor, 1),
  };
}

async function updateCustomerImage(productId, newImageUrl) {
  if (!newImageUrl) return;
  try {
    const { data: rows } = await supabase
      .from("exportcustomer_product")
      .select("id")
      .eq("product_id", productId);
    for (const row of rows || []) {
      await supabase
        .from("exportcustomer_product")
        .update({ image_url: newImageUrl })
        .eq("id", row.id);
    }
  } catch (err) {
    console.error("[updateCustomerImage:sea]", err.message);
  }
}

async function cascadeCustomerPrices(
  productId,
  variantId,
  newExFactory,
  newPurchasePrice,
) {
  try {
    // Find customer rows — try by product_id + variant_id first
    let { data: rows } = await supabase
      .from("exportcustomer_product")
      .select("*")
      .eq("product_id", productId)
      .eq("variant_id", variantId);

    if (!rows?.length) {
      const { data } = await supabase
        .from("exportcustomer_product")
        .select("*")
        .eq("product_id", productId);
      rows = data || [];
    }

    // Fallback via master product_id FK
    if (!rows?.length) {
      const { data: ep } = await supabase
        .from("exportproducts")
        .select("product_id")
        .eq("id", productId)
        .single();
      if (ep?.product_id) {
        const { data } = await supabase
          .from("exportcustomer_product")
          .select("*")
          .eq("product_id", ep.product_id);
        rows = data || [];
      }
    }

    if (!rows?.length) return;

    const { data: usdRow } = await supabase
      .from("usd_rates")
      .select("rate")
      .order("date", { ascending: false })
      .limit(1)
      .single();
    const usdRate = sf(usdRow?.rate, 304);

    for (const cp of rows) {
      const additionalUSD =
        sf(cp.export_doc) +
        sf(cp.transport_cost) +
        sf(cp.loading_cost) +
        sf(cp.airway_cost) +
        sf(cp.forwardHandling_cost);
      // Sea: FOB stored as USD (exfactory/rate + additional costs)
      const fobInUSD = newExFactory / usdRate + additionalUSD;

      const updateData = {
        purchasing_price: newPurchasePrice,
        exfactoryprice: parseFloat(newExFactory.toFixed(2)),
        fob_price: parseFloat(fobInUSD.toFixed(4)),
      };

      // Recalculate sea CNF — keep existing freight costs, just update CNF
      const fc20 = sf(cp.freight_cost_20ft);
      const fc40 = sf(cp.freight_cost_40ft);
      updateData.cnf_20ft = parseFloat((fobInUSD + fc20).toFixed(4));
      updateData.cnf_40ft = parseFloat((fobInUSD + fc40).toFixed(4));

      await supabase
        .from("exportcustomer_product")
        .update(updateData)
        .eq("id", cp.id);
      console.log(
        `[cascade:sea] ✅ updated row ${cp.id} FOB=${fobInUSD.toFixed(4)}`,
      );
    }
  } catch (err) {
    console.error("[cascadeCustomerPrices:sea]", err.message);
  }
}

export default router;
