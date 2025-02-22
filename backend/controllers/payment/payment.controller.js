import Coupon from '../../models/coupon.model.js'
import dotenv from 'dotenv'
import {
  createNewcoupon,
  createStripeCoupon
} from '../../controllers/coupon/coupon.service.js'
import { stripe } from '../../lib/stripe.js'
import Order from '../../models/order.model.js'
import { handleError } from '../../utils/errorHandler.js'

dotenv.config()

export const createCheckoutSession = async (req, res) => {
  try {
    const { products, couponCode } = req.body
    if (!Array.isArray(products) || products.length === 0) {
      return res
        .status(400)
        .json({ message: 'Invalid  or empty products array' })
    }
    let totalAmount = 0
    const lineItems = products.map((product) => {
      const amount = Math.round(product.price * 100) // convert to cents
      totalAmount += amount * product.quantity
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: product.name,
            images: [product.image]
          },
          unit_amount: amount
        },
        quantity: product.quantity
      }
    })
    let coupon = null
    if (couponCode) {
      coupon = await Coupon.findOne({
        code: couponCode,
        userId: req.user._id,
        isActive: true
      })
      if (coupon) {
        totalAmount -= Math.round(
          (totalAmount * coupon.discountPercentage) / 100
        )
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.CLIENT_URL}/purchase-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/purchase-cancelled`,
      discounts: coupon
        ? [
            {
              coupon: await createStripeCoupon(coupon.discountPercentage)
            }
          ]
        : [],
      metadata: {
        userId: req.user._id.toString(),
        couponCode: couponCode || '',
        products: JSON.stringify(
          products.map((product) => ({
            id: product._id,
            quantity: product.quantity,
            price: product.price
          }))
        )
      }
    })
    // if the user buy 200$ or more, create a new coupon for future purchase
    if (totalAmount >= 20000) {
      await createNewcoupon(req.user._id)
    }
    res.status(200).json({ id: session.id, totalAmount: totalAmount / 100 })
  } catch (error) {
    const errorMessage = handleError(error, 'Error creating checkout session')
    res.status(500).json({ message: 'Server error', errorMessage })
  }
}

export const checkoutSuccess = async (req, res) => {
  try {
    const { sessionId } = req.body
    const session = await stripe.checkout.sessions.retrieve(sessionId)

    if (session.payment_status === 'paid') {
      if (session.metadata.couponCode) {
        await Coupon.findOneAndUpdate(
          {
            code: session.metadata.couponCode,
            userId: session.metadata.userId
          },
          {
            isActive: false
          }
        )
      }
      const products = JSON.parse(session.metadata.products)
      const newOrder = new Order({
        user: session.metadata.userId,
        products: products.map((product) => ({
          product: product.id,
          quantity: product.quantity,
          price: product.price
        })),
        totalAmount: session.amount_total / 100,
        stripeSessionId: sessionId
      })

      await newOrder.save()

      res.status(200).json({
        success: true,
        message:
          'Payment successful, order created and coupon deactivated if used.',
        orderId: newOrder._id
      })
    }
  } catch (error) {
    const errorMessage = handleError(error, 'Error processing checkout success')
    res.status(500).json({ message: 'Server error', errorMessage })
  }
}
