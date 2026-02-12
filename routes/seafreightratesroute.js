import express from 'express'
import supabase from '../db.js'

const router = express.Router()

// Helper function to recalculate products affected by sea freight rate change
const recalculateSeaFreightProducts = async (country, portCode, newRateData) => {
  try {
    console.log(`Starting sea freight recalculation for ${country} - ${portCode}`)
    
    // Get current USD rate
    const { data: usdRateData, error: usdError } = await supabase
      .from('usd_rates')
      .select('rate')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (usdError || !usdRateData) {
      console.error('Could not fetch USD rate for recalculation')
      return { updated: 0, errors: 0, message: 'USD rate not found' }
    }

    const currentUsdRate = parseFloat(usdRateData.rate)

    // Find customers with matching country and port code
    const { data: customers, error: custError } = await supabase
      .from('exportcustomers')
      .select('cus_id, country, port_code')
      .eq('country', country)
      .eq('port_code', portCode)

    if (custError) {
      console.error('Error fetching customers:', custError)
      return { updated: 0, errors: 0, message: 'Error fetching customers' }
    }

    if (!customers || customers.length === 0) {
      console.log('No customers found for this country/port')
      return { updated: 0, errors: 0, message: 'No customers found' }
    }

    const customerIds = customers.map(c => c.cus_id)

    // Get all products for these customers with sea freight
    const { data: products, error: fetchError } = await supabase
      .from('exportcustomer_product')
      .select('*')
      .in('cus_id', customerIds)
      .eq('freight_type', 'sea')

    if (fetchError) throw fetchError

    if (!products || products.length === 0) {
      console.log('No sea freight products found for these customers')
      return { updated: 0, errors: 0, message: 'No products found' }
    }

    let updated = 0
    let errors = 0

    // Recalculate each product
    for (const product of products) {
      try {
        const container_type = product.container_type

        if (!container_type) {
          console.log(`Skipping product ${product.id} - missing container type`)
          continue
        }

        // Get new freight cost per kilo based on container type
        let newFreightCost = 0
        if (container_type === '20ft') {
          newFreightCost = parseFloat(newRateData.freight_per_kilo_20ft) || 0
        } else if (container_type === '40ft') {
          newFreightCost = parseFloat(newRateData.freight_per_kilo_40ft) || 0
        }

        // Get cost values (stored in USD)
        const export_doc = parseFloat(product.export_doc) || 0
        const transport_cost = parseFloat(product.transport_cost) || 0
        const loading_cost = parseFloat(product.loading_cost) || 0
        const airway_cost = parseFloat(product.airway_cost) || 0
        const forwardHandling_cost = parseFloat(product.forwardHandling_cost) || 0
        const exfactoryprice = parseFloat(product.exfactoryprice) || 0

        // Calculate total costs in USD
        const totalCostsUSD = export_doc + transport_cost + loading_cost + airway_cost + forwardHandling_cost

        // Convert total costs to LKR
        const totalCostsLKR = totalCostsUSD * currentUsdRate

        // Calculate new FOB in LKR
        const newFobPrice = exfactoryprice + totalCostsLKR

        // Calculate new CNF in USD (FOB in USD + Freight)
        const fobInUSD = newFobPrice / currentUsdRate
        const newCnf = fobInUSD + newFreightCost

        // Update the product
        const { error: updateError } = await supabase
          .from('exportcustomer_product')
          .update({
            freight_cost: parseFloat(newFreightCost.toFixed(4)),
            fob_price: parseFloat(newFobPrice.toFixed(2)),
            cnf: parseFloat(newCnf.toFixed(2))
          })
          .eq('id', product.id)

        if (updateError) {
          console.error(`Error updating product ${product.id}:`, updateError)
          errors++
        } else {
          updated++
        }
      } catch (err) {
        console.error(`Error processing product ${product.id}:`, err)
        errors++
      }
    }

    console.log(`Sea freight recalculation complete: ${updated} updated, ${errors} errors`)
    return { updated, errors }
  } catch (err) {
    console.error('Error in recalculateSeaFreightProducts:', err)
    throw err
  }
}

// GET all sea freight rates
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100

    const { data: rates, error } = await supabase
      .from('sea_freight_rates')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (error) throw error

    res.json(rates)
  } catch (err) {
    console.error('Error fetching sea freight rates:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// POST - Create new sea freight rate and recalculate affected products
router.post('/', async (req, res) => {
  try {
    const {
      country,
      port_code,
      port_name,
      rate_20ft,
      kilos_20ft,
      freight_per_kilo_20ft,
      rate_40ft,
      kilos_40ft,
      freight_per_kilo_40ft,
      date
    } = req.body

    if (!country || !port_code || !port_name ||
        !rate_20ft || !kilos_20ft || !rate_40ft || !kilos_40ft) {
      return res.status(400).json({
        message: 'Country, port code, port name, and all container rates/kilos are required'
      })
    }

    if (parseFloat(rate_20ft) <= 0 || parseFloat(rate_40ft) <= 0 ||
        parseFloat(kilos_20ft) <= 0 || parseFloat(kilos_40ft) <= 0) {
      return res.status(400).json({ message: 'All rates and kilos must be greater than 0' })
    }

    const insertData = {
      country: country.trim(),
      port_code: port_code.trim().toUpperCase(),
      port_name: port_name.trim(),
      rate_20ft: parseFloat(rate_20ft),
      kilos_20ft: parseFloat(kilos_20ft),
      freight_per_kilo_20ft: parseFloat(freight_per_kilo_20ft),
      rate_40ft: parseFloat(rate_40ft),
      kilos_40ft: parseFloat(kilos_40ft),
      freight_per_kilo_40ft: parseFloat(freight_per_kilo_40ft),
      date: date || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { data: newRate, error } = await supabase
      .from('sea_freight_rates')
      .insert(insertData)
      .select()
      .single()

    if (error) throw error

    // Recalculate affected products
    const recalcResult = await recalculateSeaFreightProducts(
      insertData.country,
      insertData.port_code,
      {
        freight_per_kilo_20ft: insertData.freight_per_kilo_20ft,
        freight_per_kilo_40ft: insertData.freight_per_kilo_40ft
      }
    )

    res.status(201).json({
      message: 'Sea freight rate added successfully',
      data: newRate,
      recalculation: {
        productsUpdated: recalcResult.updated,
        errors: recalcResult.errors
      }
    })
  } catch (err) {
    console.error('Error adding sea freight rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// PUT - Update existing sea freight rate and recalculate affected products
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const {
      country,
      port_code,
      port_name,
      rate_20ft,
      kilos_20ft,
      freight_per_kilo_20ft,
      rate_40ft,
      kilos_40ft,
      freight_per_kilo_40ft,
      date
    } = req.body

    if (!country || !port_code || !port_name ||
        !rate_20ft || !kilos_20ft || !rate_40ft || !kilos_40ft) {
      return res.status(400).json({
        message: 'Country, port code, port name, and all container rates/kilos are required'
      })
    }

    if (parseFloat(rate_20ft) <= 0 || parseFloat(rate_40ft) <= 0 ||
        parseFloat(kilos_20ft) <= 0 || parseFloat(kilos_40ft) <= 0) {
      return res.status(400).json({ message: 'All rates and kilos must be greater than 0' })
    }

    const updateData = {
      country: country.trim(),
      port_code: port_code.trim().toUpperCase(),
      port_name: port_name.trim(),
      rate_20ft: parseFloat(rate_20ft),
      kilos_20ft: parseFloat(kilos_20ft),
      freight_per_kilo_20ft: parseFloat(freight_per_kilo_20ft),
      rate_40ft: parseFloat(rate_40ft),
      kilos_40ft: parseFloat(kilos_40ft),
      freight_per_kilo_40ft: parseFloat(freight_per_kilo_40ft),
      date: date || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { data: updatedRate, error } = await supabase
      .from('sea_freight_rates')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    // Recalculate affected products
    const recalcResult = await recalculateSeaFreightProducts(
      updateData.country,
      updateData.port_code,
      {
        freight_per_kilo_20ft: updateData.freight_per_kilo_20ft,
        freight_per_kilo_40ft: updateData.freight_per_kilo_40ft
      }
    )

    res.json({
      message: 'Sea freight rate updated successfully',
      data: updatedRate,
      recalculation: {
        productsUpdated: recalcResult.updated,
        errors: recalcResult.errors
      }
    })
  } catch (err) {
    console.error('Error updating sea freight rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// DELETE - Remove sea freight rate
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('sea_freight_rates')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({ message: 'Sea freight rate deleted successfully' })
  } catch (err) {
    console.error('Error deleting sea freight rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

export default router