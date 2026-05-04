import express from "express";
import supabase from "../db.js";
import multer from "multer";
import { extname } from "path";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });
const sf = (v, d = 0) => (isFinite(parseFloat(v)) ? parseFloat(v) : d);

// ── image upload helper ────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════
// GET /api/exportproductlistair
// ═══════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from("exportproductsair")
      .select("*")
      .order("common_name");
    if (error) throw error;

    const result = (products || []).map((p) => ({
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
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/exportproductlistair/:id
router.get("/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("exportproductsair")
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
// POST /api/exportproductlistair/upload — add product
// ═══════════════════════════════════════════════════════════════
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
      : req.body.image_url_direct || null; // use direct URL if no file

    let variantsData = [];
    try {
      variantsData =
        typeof variants === "string" ? JSON.parse(variants) : variants || [];
      if (!Array.isArray(variantsData)) variantsData = [];
    } catch {
      variantsData = [];
    }

    const { data, error } = await supabase
      .from("exportproductsair")
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

// ═══════════════════════════════════════════════════════════════
// PUT /api/exportproductlistair/upload/:id — update product
// ═══════════════════════════════════════════════════════════════
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
      : existing_image_url || null;

    const { data: current, error: fetchErr } = await supabase
      .from("exportproductsair")
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

    // Only update product_id if it differs from this record's own id
    // (prevents setting product_id to exportproductsair.id when editing existing)
    const parsedProductId = product_id ? parseInt(product_id) : null;
    const shouldSetProductId =
      parsedProductId && parsedProductId !== parseInt(req.params.id);

    const updatePayload = {
      common_name,
      scientific_name,
      description,
      category,
      species_type,
      image_url: image_url || null,
      variants: variantsData,
      ...(shouldSetProductId ? { product_id: parsedProductId } : {}),
    };

    const { error: updateErr } = await supabase
      .from("exportproductsair")
      .update(updatePayload)
      .eq("id", req.params.id);
    if (updateErr) throw updateErr;

    // Cascade image update to customer table
    if (image_url && current.image_url !== image_url) {
      await updateCustomerImage(req.params.id, image_url);
    }

    // Cascade pricing changes to customer table
    // Always cascade on PUT — exfactoryprice may change due to profit/packing edits
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
      .from("exportproductsair")
      .select("*")
      .eq("id", req.params.id)
      .single();
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/exportproductlistair/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("exportproductsair")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ message: "Product deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// VARIANT ROUTES
// ═══════════════════════════════════════════════════════════════

router.get("/:productId/variants", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("exportproductsair")
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
      .from("exportproductsair")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fe) throw fe;

    const variants = Array.isArray(prod.variants) ? prod.variants : [];
    const newVar = buildVariant(req.body);
    const { error } = await supabase
      .from("exportproductsair")
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
      .from("exportproductsair")
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
      .from("exportproductsair")
      .update({ variants: updated })
      .eq("id", productId);
    if (error) throw error;

    // Always cascade CNF recalculation on variant save
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
      .from("exportproductsair")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fe) throw fe;
    const updated = (prod.variants || []).filter((v) => v.id != variantId);
    const { error } = await supabase
      .from("exportproductsair")
      .update({ variants: updated })
      .eq("id", productId);
    if (error) throw error;
    res.json({ message: "Variant deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function buildVariant(body, existing = null) {
  const id = existing?.id || Date.now();
  return {
    id,
    size: body.size || existing?.size || "",
    unit: body.unit || existing?.unit || "kg",
    purchasing_price: sf(body.purchasing_price),
    jc_fob: sf(body.jc_fob),
    usdrate: sf(body.usdrate, 304),
    labour_overhead: sf(body.labour_overhead),
    packing_cost: sf(body.packing_cost),
    profit: sf(body.profit),
    profit_usd: sf(body.profit_usd),
    profit_lkr: sf(body.profit_lkr),
    profit_currency: body.profit_currency || "usd",
    profit_margin: sf(body.profit_margin),
    exfactoryprice: sf(body.exfactoryprice),
    multiplier: sf(body.multiplier),
    divisor: sf(body.divisor, 1),
  };
}

async function updateCustomerImage(productId, newImageUrl) {
  if (!newImageUrl) return;
  try {
    const { data: rows } = await supabase
      .from("exportcustomer_productair")
      .select("id")
      .eq("product_id", productId);
    for (const row of rows || []) {
      await supabase
        .from("exportcustomer_productair")
        .update({ image_url: newImageUrl })
        .eq("id", row.id);
    }
  } catch (err) {
    console.error("[updateCustomerImage]", err.message);
  }
}

async function cascadeCustomerPrices(
  productId,
  variantId,
  newExFactory,
  newPurchasePrice,
) {
  try {
    // Try exact match by exportproductsair.id + variant_id
    let { data: rows } = await supabase
      .from("exportcustomer_productair")
      .select("*")
      .eq("product_id", productId)
      .eq("variant_id", variantId);

    // Fallback: match by variant_id only across all customer rows for this product
    if (!rows?.length) {
      const { data } = await supabase
        .from("exportcustomer_productair")
        .select("*")
        .eq("product_id", productId);
      rows = data || [];
    }

    // Fallback 2: find via master product_id stored on exportproductsair
    if (!rows?.length) {
      const { data: ep } = await supabase
        .from("exportproductsair")
        .select("product_id")
        .eq("id", productId)
        .single();
      if (ep?.product_id) {
        const { data } = await supabase
          .from("exportcustomer_productair")
          .select("*")
          .eq("product_id", ep.product_id);
        rows = data || [];
      }
    }

    if (!rows?.length) {
      console.log(
        `[cascadeCustomerPrices] no rows found for product=${productId} variant=${variantId}`,
      );
      return;
    }

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

      const fobInUSD = newExFactory / usdRate + additionalUSD;

      const updateData = {
        purchasing_price: newPurchasePrice,
        exfactoryprice: parseFloat(newExFactory.toFixed(2)),
        fob_price: parseFloat(fobInUSD.toFixed(4)),
      };

      // Recalculate CNF using customer's freight rates
      const { data: customer } = await supabase
        .from("exportcustomersair")
        .select("country, airport_code")
        .eq("cus_id", cp.cus_id)
        .single();

      if (customer) {
        let q = supabase
          .from("freight_rates")
          .select("*")
          .eq("country", customer.country)
          .order("date", { ascending: false })
          .limit(1);
        if (customer.airport_code)
          q = supabase
            .from("freight_rates")
            .select("*")
            .eq("country", customer.country)
            .eq("airport_code", customer.airport_code)
            .order("date", { ascending: false })
            .limit(1);

        const { data: rates } = await q;
        const rate = rates?.[0];
        const m = sf(cp.multiplier, 1);
        const d = sf(cp.divisor, 1) || 1;

        if (rate) {
          const fc45 = (m * sf(rate.rate_45kg)) / d;
          const fc100 = (m * sf(rate.rate_100kg)) / d;
          const fc300 = (m * sf(rate.rate_300kg)) / d;
          const fc500 = (m * sf(rate.rate_500kg)) / d;
          Object.assign(updateData, {
            freight_cost_45kg: fc45,
            freight_cost_100kg: fc100,
            freight_cost_300kg: fc300,
            freight_cost_500kg: fc500,
            cnf_45kg: parseFloat((fobInUSD + fc45).toFixed(4)),
            cnf_100kg: parseFloat((fobInUSD + fc100).toFixed(4)),
            cnf_300kg: parseFloat((fobInUSD + fc300).toFixed(4)),
            cnf_500kg: parseFloat((fobInUSD + fc500).toFixed(4)),
          });
        } else {
          // No fresh rate — keep existing freight, recalc CNF
          const fc45 = sf(cp.freight_cost_45kg);
          const fc100 = sf(cp.freight_cost_100kg);
          const fc300 = sf(cp.freight_cost_300kg);
          const fc500 = sf(cp.freight_cost_500kg);
          Object.assign(updateData, {
            cnf_45kg: parseFloat((fobInUSD + fc45).toFixed(4)),
            cnf_100kg: parseFloat((fobInUSD + fc100).toFixed(4)),
            cnf_300kg: parseFloat((fobInUSD + fc300).toFixed(4)),
            cnf_500kg: parseFloat((fobInUSD + fc500).toFixed(4)),
          });
        }
      } else {
        // No customer record — keep existing freight, recalc CNF
        const fc45 = sf(cp.freight_cost_45kg);
        const fc100 = sf(cp.freight_cost_100kg);
        const fc300 = sf(cp.freight_cost_300kg);
        const fc500 = sf(cp.freight_cost_500kg);
        Object.assign(updateData, {
          cnf_45kg: parseFloat((fobInUSD + fc45).toFixed(4)),
          cnf_100kg: parseFloat((fobInUSD + fc100).toFixed(4)),
          cnf_300kg: parseFloat((fobInUSD + fc300).toFixed(4)),
          cnf_500kg: parseFloat((fobInUSD + fc500).toFixed(4)),
        });
      }

      await supabase
        .from("exportcustomer_productair")
        .update(updateData)
        .eq("id", cp.id);
      console.log(
        `[cascade] ✅ updated customer row ${cp.id} FOB=${fobInUSD.toFixed(4)}`,
      );
    }
  } catch (err) {
    console.error("[cascadeCustomerPrices]", err.message);
  }
}

export default router;
