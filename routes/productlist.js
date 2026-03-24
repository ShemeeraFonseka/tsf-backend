import express from "express";
import supabase from "../db.js";
import multer from "multer";
import path from "path";

const router = express.Router();

// Configure multer for memory storage (we'll upload to Supabase Storage)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// GET all products with their variants
router.get("/", async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .order("common_name");

    if (error) throw error;

    // Sort products by their lowest variant price
    const sortedProducts = products
      .map((product) => {
        if (product.variants && product.variants.length > 0) {
          product.variants.sort((a, b) => {
            return (
              parseFloat(a.purchasing_price) - parseFloat(b.purchasing_price)
            );
          });
        }
        return product;
      })
      .sort((a, b) => {
        const priceA =
          a.variants && a.variants.length > 0
            ? Math.min(...a.variants.map((v) => parseFloat(v.purchasing_price)))
            : Infinity;
        const priceB =
          b.variants && b.variants.length > 0
            ? Math.min(...b.variants.map((v) => parseFloat(v.purchasing_price)))
            : Infinity;
        return priceA - priceB;
      });

    res.json(sortedProducts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// GET single product by ID
router.get("/:id", async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from("products")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ error: "Product not found" });
      }
      throw error;
    }

    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// POST - Add new product with variants
router.post("/upload", upload.single("image"), async (req, res) => {
  const {
    common_name,
    scientific_name,
    category,
    description,
    species_type,
    variants,
  } = req.body;
  let image_url = null;

  try {
    if (req.file) {
      const fileName = `${Date.now()}${path.extname(req.file.originalname)}`;
      const { error: uploadError } = await supabase.storage
        .from("product-images")
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
        });

      if (uploadError) throw uploadError;

      const {
        data: { publicUrl },
      } = supabase.storage.from("product-images").getPublicUrl(fileName);

      image_url = publicUrl;
    }

    const variantsData =
      typeof variants === "string" ? JSON.parse(variants) : variants || [];

    const { data, error } = await supabase
      .from("products")
      .insert({
        common_name,
        scientific_name,
        category,
        description,
        species_type,
        image_url,
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

// PUT - Update product with variants
router.put("/upload/:id", upload.single("image"), async (req, res) => {
  const {
    common_name,
    scientific_name,
    description,
    category,
    species_type,
    existing_image_url,
    variants,
  } = req.body;
  let image_url = existing_image_url;

  try {
    const { data: currentProduct, error: fetchError } = await supabase
      .from("products")
      .select("variants")
      .eq("id", req.params.id)
      .single();

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        return res.status(404).json({ error: "Product not found" });
      }
      throw fetchError;
    }

    if (req.file) {
      const fileName = `${Date.now()}${path.extname(req.file.originalname)}`;
      const { error: uploadError } = await supabase.storage
        .from("product-images")
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
        });

      if (uploadError) throw uploadError;

      const {
        data: { publicUrl },
      } = supabase.storage.from("product-images").getPublicUrl(fileName);

      image_url = publicUrl;
    }

    const variantsData =
      typeof variants === "string" ? JSON.parse(variants) : variants || [];

    const { error: updateError } = await supabase
      .from("products")
      .update({
        common_name,
        scientific_name,
        description,
        category,
        species_type,
        image_url,
        variants: variantsData,
      })
      .eq("id", req.params.id);

    if (updateError) throw updateError;

    // Check for price/profit changes and cascade to customer_product
    if (currentProduct && currentProduct.variants) {
      const oldVariants = currentProduct.variants;
      const newVariants = variantsData;

      for (const newVariant of newVariants) {
        const oldVariant = oldVariants.find((v) => v.id === newVariant.id);
        if (!oldVariant) continue;

        const purchaseChanged =
          oldVariant.purchasing_price !== newVariant.purchasing_price;
        const profitChanged = oldVariant.profit !== newVariant.profit;

        if (!purchaseChanged && !profitChanged) continue;

        // Fetch all customer prices for this variant
        const { data: customerPrices, error: fetchPricesError } = await supabase
          .from("customer_product")
          .select("*")
          .eq("product_id", req.params.id)
          .eq("variant_id", newVariant.id);

        if (fetchPricesError) {
          console.error("Error fetching customer prices:", fetchPricesError);
          continue;
        }

        for (const customerPrice of customerPrices) {
          let updatePayload;

          if (profitChanged) {
            // Apply same profit from product variant to customer, recalculate selling_price
            const newProfit = newVariant.profit ?? 0;
            const newSellingPrice = customerPrice.purchasing_price + newProfit;
            const newMarginPercentage =
              newSellingPrice > 0 ? (newProfit / newSellingPrice) * 100 : 0;

            updatePayload = {
              margin: newProfit,
              selling_price: newSellingPrice,
              margin_percentage: newMarginPercentage,
            };
          } else {
            // purchasing_price changed — keep margin fixed, recalculate selling_price
            const margin = customerPrice.margin ?? 0;
            const newSellingPrice = newVariant.purchasing_price + margin;
            const newMarginPercentage =
              newSellingPrice > 0 ? (margin / newSellingPrice) * 100 : 0;

            updatePayload = {
              purchasing_price: newVariant.purchasing_price,
              selling_price: newSellingPrice,
              margin: margin,
              margin_percentage: newMarginPercentage,
            };
          }

          const { error: updatePriceError } = await supabase
            .from("customer_product")
            .update(updatePayload)
            .eq("id", customerPrice.id);

          if (updatePriceError) {
            console.error("Error updating customer price:", updatePriceError);
          }
        }
      }
    }

    const { data: updatedProduct, error: fetchUpdatedError } = await supabase
      .from("products")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (fetchUpdatedError) throw fetchUpdatedError;

    res.json(updatedProduct);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE product
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;

    res.json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// ============== VARIANT OPERATIONS (within same product record) ==============

// GET all variants for a product
router.get("/:productId/variants", async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from("products")
      .select("variants")
      .eq("id", req.params.productId)
      .single();

    if (error) throw error;

    res.json(product.variants || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// POST - Add new variant to a product
router.post("/:productId/variants", async (req, res) => {
  const {
    size,
    unit,
    purchasing_price,
    profit,
    profit_margin_percentage,
    selling_price,
  } = req.body;
  const { productId } = req.params;

  try {
    const { data: product, error: fetchError } = await supabase
      .from("products")
      .select("variants")
      .eq("id", productId)
      .single();

    if (fetchError) throw fetchError;

    let calculatedProfit = profit;
    let calculatedMarginPercentage = profit_margin_percentage;
    let calculatedSellingPrice = selling_price;

    if (selling_price && !profit && !profit_margin_percentage) {
      calculatedProfit =
        parseFloat(selling_price) - parseFloat(purchasing_price);
      calculatedMarginPercentage =
        (calculatedProfit / parseFloat(selling_price)) * 100;
    } else if (profit && !selling_price) {
      calculatedSellingPrice =
        parseFloat(purchasing_price) + parseFloat(profit);
      calculatedMarginPercentage =
        (parseFloat(profit) / calculatedSellingPrice) * 100;
    } else if (profit_margin_percentage && !selling_price) {
      const marginDecimal = parseFloat(profit_margin_percentage) / 100;
      calculatedSellingPrice =
        parseFloat(purchasing_price) / (1 - marginDecimal);
      calculatedProfit = calculatedSellingPrice - parseFloat(purchasing_price);
    }

    const currentVariants = product.variants || [];
    const newVariant = {
      id: Date.now(),
      size,
      unit,
      purchasing_price: parseFloat(purchasing_price),
      profit: calculatedProfit ? parseFloat(calculatedProfit) : 0,
      profit_margin_percentage: calculatedMarginPercentage
        ? parseFloat(calculatedMarginPercentage)
        : 0,
      selling_price: calculatedSellingPrice
        ? parseFloat(calculatedSellingPrice)
        : parseFloat(purchasing_price),
    };
    const updatedVariants = [...currentVariants, newVariant];

    const { error: updateError } = await supabase
      .from("products")
      .update({ variants: updatedVariants })
      .eq("id", productId);

    if (updateError) throw updateError;

    res.status(201).json(newVariant);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// PUT - Update a specific variant
router.put("/:productId/variants/:variantId", async (req, res) => {
  const {
    size,
    unit,
    purchasing_price,
    profit,
    profit_margin_percentage,
    selling_price,
  } = req.body;
  const { productId, variantId } = req.params;

  try {
    const { data: product, error: fetchError } = await supabase
      .from("products")
      .select("variants")
      .eq("id", productId)
      .single();

    if (fetchError) throw fetchError;

    const currentVariants = product.variants || [];
    const oldVariant = currentVariants.find((v) => v.id == variantId);
    const oldPrice = oldVariant?.purchasing_price;
    const oldProfit = oldVariant?.profit;

    let calculatedProfit = profit;
    let calculatedMarginPercentage = profit_margin_percentage;
    let calculatedSellingPrice = selling_price;

    if (selling_price && !profit && !profit_margin_percentage) {
      calculatedProfit =
        parseFloat(selling_price) - parseFloat(purchasing_price);
      calculatedMarginPercentage =
        (calculatedProfit / parseFloat(selling_price)) * 100;
    } else if (profit && !selling_price) {
      calculatedSellingPrice =
        parseFloat(purchasing_price) + parseFloat(profit);
      calculatedMarginPercentage =
        (parseFloat(profit) / calculatedSellingPrice) * 100;
    } else if (profit_margin_percentage && !selling_price) {
      const marginDecimal = parseFloat(profit_margin_percentage) / 100;
      calculatedSellingPrice =
        parseFloat(purchasing_price) / (1 - marginDecimal);
      calculatedProfit = calculatedSellingPrice - parseFloat(purchasing_price);
    }

    const finalProfit = calculatedProfit
      ? parseFloat(calculatedProfit)
      : profit || oldVariant?.profit || 0;

    const updatedVariants = currentVariants.map((v) =>
      v.id == variantId
        ? {
            ...v,
            size,
            unit,
            purchasing_price: parseFloat(purchasing_price),
            profit: finalProfit,
            profit_margin_percentage: calculatedMarginPercentage
              ? parseFloat(calculatedMarginPercentage)
              : profit_margin_percentage || v.profit_margin_percentage || 0,
            selling_price: calculatedSellingPrice
              ? parseFloat(calculatedSellingPrice)
              : selling_price ||
                v.selling_price ||
                parseFloat(purchasing_price),
          }
        : v,
    );

    const { error: updateError } = await supabase
      .from("products")
      .update({ variants: updatedVariants })
      .eq("id", productId);

    if (updateError) throw updateError;

    const purchaseChanged =
      oldPrice !== undefined && oldPrice !== parseFloat(purchasing_price);
    const profitChanged = oldProfit !== undefined && oldProfit !== finalProfit;

    if (purchaseChanged || profitChanged) {
      await updateCustomerPricesForVariant(
        productId,
        variantId,
        parseFloat(purchasing_price),
        oldPrice,
        profitChanged ? finalProfit : null,
      );
    }

    const updatedVariant = updatedVariants.find((v) => v.id == variantId);
    res.json(updatedVariant);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// DELETE - Remove a specific variant
router.delete("/:productId/variants/:variantId", async (req, res) => {
  const { productId, variantId } = req.params;

  try {
    const { data: product, error: fetchError } = await supabase
      .from("products")
      .select("variants")
      .eq("id", productId)
      .single();

    if (fetchError) throw fetchError;

    const currentVariants = product.variants || [];
    const updatedVariants = currentVariants.filter((v) => v.id != variantId);

    const { error: updateError } = await supabase
      .from("products")
      .update({ variants: updatedVariants })
      .eq("id", productId);

    if (updateError) throw updateError;

    res.json({ message: "Variant deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// Helper function to update customer prices
// - newProfit = null  → purchasing_price changed, keep margin fixed
// - newProfit = value → profit changed, apply same profit to all customers
async function updateCustomerPricesForVariant(
  productId,
  variantId,
  newPurchasePrice,
  oldPurchasePrice,
  newProfit = null,
) {
  try {
    const { data: customerPrices, error: fetchPricesError } = await supabase
      .from("customer_product")
      .select("*")
      .eq("product_id", productId)
      .eq("variant_id", variantId);

    if (fetchPricesError) {
      console.error("Error fetching customer prices:", fetchPricesError);
      return;
    }

    for (const customerPrice of customerPrices) {
      let updatePayload;

      if (newProfit !== null) {
        // Profit changed — apply same profit amount, recalculate selling_price
        const newSellingPrice = customerPrice.purchasing_price + newProfit;
        const newMarginPercentage =
          newSellingPrice > 0 ? (newProfit / newSellingPrice) * 100 : 0;

        updatePayload = {
          margin: newProfit,
          selling_price: newSellingPrice,
          margin_percentage: newMarginPercentage,
        };
      } else {
        // purchasing_price changed — keep margin fixed, recalculate selling_price
        const margin = customerPrice.margin ?? 0;
        const newSellingPrice = newPurchasePrice + margin;
        const newMarginPercentage =
          newSellingPrice > 0 ? (margin / newSellingPrice) * 100 : 0;

        updatePayload = {
          purchasing_price: newPurchasePrice,
          selling_price: newSellingPrice,
          margin: margin,
          margin_percentage: newMarginPercentage,
        };
      }

      const { error: updatePriceError } = await supabase
        .from("customer_product")
        .update(updatePayload)
        .eq("id", customerPrice.id);

      if (updatePriceError) {
        console.error("Error updating customer price:", updatePriceError);
      }
    }
  } catch (err) {
    console.error("Error in updateCustomerPricesForVariant:", err);
  }
}

export default router;
