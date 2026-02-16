import express from 'express'
import supabase from '../db.js'
import multer from 'multer'
import { extname } from 'path'

const router = express.Router()

// Configure multer for memory storage (we'll upload to Supabase Storage)
const storage = multer.memoryStorage()
const upload = multer({ storage })

// GET all products with their variants
router.get('/', async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from('exportproducts')
      .select('*')
      .order('common_name')

    if (error) throw error

    // Sort products by their lowest variant price
    const sortedProducts = products.map(product => {
      // Sort variants within each product by purchasing_price
      if (product.variants && product.variants.length > 0) {
        product.variants.sort((a, b) => {
          return parseFloat(a.purchasing_price) - parseFloat(b.purchasing_price)
        })
      }
      return product
    }).sort((a, b) => {
      // Sort products by their lowest variant price
      const priceA = a.variants && a.variants.length > 0
        ? Math.min(...a.variants.map(v => parseFloat(v.purchasing_price)))
        : Infinity
      
      const priceB = b.variants && b.variants.length > 0
        ? Math.min(...b.variants.map(v => parseFloat(v.purchasing_price)))
        : Infinity
      
      return priceA - priceB
    })

    res.json(sortedProducts)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// GET single product by ID
router.get('/:id', async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from('exportproducts')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Product not found' })
      }
      throw error
    }

    res.json(product)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// POST - Add new product with variants
router.post('/upload', upload.single('image'), async (req, res) => {
  const { common_name, scientific_name, category, species_type, variants } = req.body
  let image_url = null

  try {
    if (req.file) {
      const fileName = `${Date.now()}${extname(req.file.originalname)}`
      const { error: uploadError } = await supabase.storage
        .from('product-images')
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype
        })

      if (uploadError) throw uploadError

      const { data: { publicUrl } } = supabase.storage
        .from('product-images')
        .getPublicUrl(fileName)

      image_url = publicUrl
    }

    // Parse variants if it's a string
    const variantsData = typeof variants === 'string' ? JSON.parse(variants) : (variants || [])

    const { data, error } = await supabase
      .from('exportproducts')
      .insert({
        common_name,
        scientific_name,
        category,
        species_type,
        image_url,
        variants: variantsData
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Helper function to update export customer prices when variant changes
async function updateExportCustomerPricesForVariant(productId, variantId, newExFactoryPrice, oldExFactoryPrice, newPurchasePrice, oldPurchasePrice) {
  try {
    // Get all customer prices for this product/variant
    const { data: customerPrices, error: fetchPricesError } = await supabase
      .from('exportcustomer_product')
      .select('*')
      .eq('product_id', productId)
      .eq('variant_id', variantId)

    if (fetchPricesError) {
      console.error('Error fetching export customer prices:', fetchPricesError)
      return
    }

    // Update each customer price
    for (const customerPrice of customerPrices) {
      // Recalculate FOB price based on new ex-factory price
      const exFactoryDiff = newExFactoryPrice - oldExFactoryPrice
      const newFobPrice = parseFloat(customerPrice.fob_price) + exFactoryDiff

      // Get freight cost (stored in USD)
      const freightCostUSD = parseFloat(customerPrice.freight_cost) || 0

      // Recalculate CNF
      // First, get current USD rate to convert FOB to USD
      const { data: usdRateData } = await supabase
        .from('usd_rate')
        .select('rate')
        .order('date', { ascending: false })
        .limit(1)
        .single()

      const usdRate = usdRateData?.rate || 300 // fallback rate

      // Convert new FOB price to USD
      const fobInUSD = newFobPrice / usdRate
      
      // Calculate new CNF
      const newCNF = fobInUSD + freightCostUSD

      // Prepare update object
      const updateData = {
        purchasing_price: newPurchasePrice,
        exfactoryprice: newExFactoryPrice,
        fob_price: newFobPrice,
        cnf: newCNF
      }

      // If margin percentage or margin exists, recalculate those too
      if (customerPrice.margin_percentage > 0) {
        // Keep same margin percentage, recalculate margin
        const margin = (newExFactoryPrice * customerPrice.margin_percentage) / 100
        updateData.margin = margin
      } else if (customerPrice.margin > 0) {
        // Keep same margin amount, recalculate percentage
        const marginPercentage = (customerPrice.margin / newExFactoryPrice) * 100
        updateData.margin_percentage = marginPercentage
      }

      const { error: updatePriceError } = await supabase
        .from('exportcustomer_product')
        .update(updateData)
        .eq('id', customerPrice.id)

      if (updatePriceError) {
        console.error('Error updating export customer price:', updatePriceError)
      }
    }
  } catch (err) {
    console.error('Error in updateExportCustomerPricesForVariant:', err)
  }
}

// PUT - Update product with variants
router.put('/upload/:id', upload.single('image'), async (req, res) => {
  const { common_name, scientific_name, category, species_type, existing_image_url, variants } = req.body
  let image_url = existing_image_url

  try {
    // Get the current product to check for price changes
    const { data: currentProduct, error: fetchError } = await supabase
      .from('exportproducts')
      .select('variants')
      .eq('id', req.params.id)
      .single()

    if (fetchError) throw fetchError

    if (req.file) {
      const fileName = `${Date.now()}${extname(req.file.originalname)}`
      await supabase.storage
        .from('product-images')
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype
        })

      const { data: { publicUrl } } = supabase.storage
        .from('product-images')
        .getPublicUrl(fileName)

      image_url = publicUrl
    }

    // Parse variants if it's a string
    const variantsData = typeof variants === 'string' ? JSON.parse(variants) : (variants || [])

    // Update product
    const { error: updateError } = await supabase
      .from('exportproducts')
      .update({
        common_name,
        scientific_name,
        category,
        species_type,
        image_url,
        variants: variantsData
      })
      .eq('id', req.params.id)

    if (updateError) throw updateError

    // Check if prices have changed and update customer prices
    if (currentProduct && currentProduct.variants) {
      const oldVariants = currentProduct.variants
      const newVariants = variantsData

      // Find variants where prices changed
      for (const newVariant of newVariants) {
        const oldVariant = oldVariants.find(v => v.id === newVariant.id)
        
        if (oldVariant) {
          const purchasePriceChanged = oldVariant.purchasing_price !== newVariant.purchasing_price
          const exFactoryPriceChanged = oldVariant.exfactoryprice !== newVariant.exfactoryprice

          if (purchasePriceChanged || exFactoryPriceChanged) {
            await updateExportCustomerPricesForVariant(
              req.params.id,
              newVariant.id,
              newVariant.exfactoryprice,
              oldVariant.exfactoryprice,
              newVariant.purchasing_price,
              oldVariant.purchasing_price
            )
          }
        }
      }
    }

    // Fetch and return updated product
    const { data } = await supabase
      .from('exportproducts')
      .select('*')
      .eq('id', req.params.id)
      .single()

    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE product
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('exportproducts')
      .delete()
      .eq('id', req.params.id)

    if (error) throw error

    res.json({ message: 'Product deleted' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// ============== VARIANT OPERATIONS (within same product record) ==============

// GET all variants for a product
router.get('/:productId/variants', async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from('exportproducts')
      .select('variants')
      .eq('id', req.params.productId)
      .single()

    if (error) throw error

    res.json(product.variants || [])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// POST - Add new variant to a product
router.post('/:productId/variants', async (req, res) => {
  const { 
    size, 
    unit, 
    purchasing_price, 
    usdrate, 
    labour_overhead, 
    packing_cost, 
    profit, 
    profit_margin, 
    exfactoryprice,
    multiplier,
    divisor
  } = req.body
  const { productId } = req.params

  try {
    // Get current product
    const { data: product, error: fetchError } = await supabase
      .from('exportproducts')
      .select('variants')
      .eq('id', productId)
      .single()

    if (fetchError) throw fetchError

    // Add new variant with unique ID
    const currentVariants = product.variants || []
    const newVariant = {
      id: Date.now(),
      size,
      unit,
      purchasing_price: parseFloat(purchasing_price),
      usdrate: parseFloat(usdrate),
      labour_overhead: parseFloat(labour_overhead),
      packing_cost: parseFloat(packing_cost),
      profit: parseFloat(profit),
      profit_margin: parseFloat(profit_margin),
      exfactoryprice: parseFloat(exfactoryprice),
      multiplier: parseFloat(multiplier) || 0,
      divisor: parseFloat(divisor) || 1
    }
    const updatedVariants = [...currentVariants, newVariant]

    // Update product with new variants array
    const { error: updateError } = await supabase
      .from('exportproducts')
      .update({ variants: updatedVariants })
      .eq('id', productId)

    if (updateError) throw updateError

    res.status(201).json(newVariant)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// PUT - Update a specific variant
router.put('/:productId/variants/:variantId', async (req, res) => {
  const { 
    size, 
    unit, 
    purchasing_price, 
    usdrate, 
    labour_overhead, 
    packing_cost, 
    profit, 
    profit_margin, 
    exfactoryprice,
    multiplier,
    divisor
  } = req.body
  const { productId, variantId } = req.params

  try {
    // Get current product
    const { data: product, error: fetchError } = await supabase
      .from('exportproducts')
      .select('variants')
      .eq('id', productId)
      .single()

    if (fetchError) throw fetchError

    // Find the variant being updated to get old prices
    const currentVariants = product.variants || []
    const oldVariant = currentVariants.find(v => v.id == variantId)
    const oldExFactoryPrice = oldVariant?.exfactoryprice
    const oldPurchasePrice = oldVariant?.purchasing_price

    // Update the specific variant
    const updatedVariants = currentVariants.map(v =>
      v.id == variantId
        ? {
            ...v,
            size,
            unit,
            purchasing_price: parseFloat(purchasing_price),
            usdrate: parseFloat(usdrate),
            labour_overhead: parseFloat(labour_overhead),
            packing_cost: parseFloat(packing_cost),
            profit: parseFloat(profit),
            profit_margin: parseFloat(profit_margin),
            exfactoryprice: parseFloat(exfactoryprice),
            multiplier: parseFloat(multiplier) || 0,
            divisor: parseFloat(divisor) || 1
          }
        : v
    )

    // Update product with modified variants array
    const { error: updateError } = await supabase
      .from('exportproducts')
      .update({ variants: updatedVariants })
      .eq('id', productId)

    if (updateError) throw updateError

    // If ex-factory price changed, update customer prices
    if (oldExFactoryPrice && oldExFactoryPrice !== parseFloat(exfactoryprice)) {
      await updateExportCustomerPricesForVariant(
        productId,
        variantId,
        parseFloat(exfactoryprice),
        oldExFactoryPrice,
        parseFloat(purchasing_price),
        oldPurchasePrice
      )
    }

    const updatedVariant = updatedVariants.find(v => v.id == variantId)
    res.json(updatedVariant)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// DELETE - Remove a specific variant
router.delete('/:productId/variants/:variantId', async (req, res) => {
  const { productId, variantId } = req.params

  try {
    // Get current product
    const { data: product, error: fetchError } = await supabase
      .from('exportproducts')
      .select('variants')
      .eq('id', productId)
      .single()

    if (fetchError) throw fetchError

    // Remove the specific variant
    const currentVariants = product.variants || []
    const updatedVariants = currentVariants.filter(v => v.id != variantId)

    // Update product with filtered variants array
    const { error: updateError } = await supabase
      .from('exportproducts')
      .update({ variants: updatedVariants })
      .eq('id', productId)

    if (updateError) throw updateError

    res.json({ message: 'Variant deleted' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

export default router