const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files from the root directory to allow access to staff.html
app.use(express.static(path.join(__dirname, '..')));

// Simple configuration for taxes and fees
const CONFIG = {
  TAX_RATE: 0.08, // 8%
  DELIVERY_FEE: 5.00
};

// Session-based order storage (In-memory)
const orders = new Map();

/**
 * Helper to find a menu item by name
 */
function findMenuItem(menuData, itemName) {
  for (const category of menuData) {
    const item = category.items.find(i => i.name.toLowerCase() === itemName.toLowerCase());
    if (item) return item;
  }
  return null;
}

/**
 * Calculates the deterministic total based on menu data and current order state
 */
function calculateOrderTotal(orderState, menuData) {
  let subtotal = 0;
  orderState.items.forEach(item => {
    const menuItem = findMenuItem(menuData, item.name);
    if (menuItem) {
      subtotal += menuItem.price * item.quantity;
    }
  });

  let discount = 0;
  if (orderState.promotion) {
    const promoPath = path.join(__dirname, '..', 'data', 'promotions.json');
    const promotions = JSON.parse(fs.readFileSync(promoPath, 'utf8'));
    const promo = promotions.find(p => p.code === orderState.promotion);

    if (promo && promo.active) {
      if (promo.discount_type === 'percentage') {
        discount = subtotal * (promo.value / 100);
      } else if (promo.discount_type === 'fixed') {
        discount = promo.value;
      }
    }
  }

  let total = subtotal - discount;

  if (orderState.orderType === 'delivery') {
    total += CONFIG.DELIVERY_FEE;
  }

  const tax = total * CONFIG.TAX_RATE;
  total += tax;

  return {
    subtotal: Math.max(0, subtotal),
    discount: Math.max(0, discount),
    deliveryFee: orderState.orderType === 'delivery' ? CONFIG.DELIVERY_FEE : 0,
    tax: Math.max(0, tax),
    finalTotal: Math.max(0, total)
  };
}

/**
 * GET /api/orders
 * Retrieves all confirmed orders from data/orders.json
 */
app.get('/api/orders', (req, res) => {
  try {
    const ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
    const allOrders = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
    res.json(allOrders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * PATCH /api/orders/:id
 * Updates the status of a specific order
 */
app.patch('/api/orders/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
    const allOrders = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));

    const orderIndex = allOrders.findIndex(o => o.orderId === id);
    if (orderIndex === -1) {
      return res.status(404).json({ error: 'Order not found' });
    }

    allOrders[orderIndex].status = status;
    fs.writeFileSync(ordersPath, JSON.stringify(allOrders, null, 2));

    res.json({ message: 'Order status updated successfully', order: allOrders[orderIndex] });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * POST /api/chat
 * Handles customer messages and returns bot responses.
 * Body: { message: string, history: Array, sessionId: string }
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, sessionId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required for order tracking' });
    }

    const promptPath = path.join(__dirname, '..', 'prompts', 'system-prompt.md');
    const systemPrompt = fs.readFileSync(promptPath, 'utf8');

    const menuPath = path.join(__dirname, '..', 'data', 'menu.json');
    const menuData = JSON.parse(fs.readFileSync(menuPath, 'utf8'));

    let orderState = orders.get(sessionId) || {
      items: [],
      orderType: null,
      customerDetails: {},
      promotion: null,
      total: 0,
      confirmation: false,
      status: 'pending',
      deliveryConfirmed: false
    };

    let botResponse = "";
    let itemFound = null;

    for (const category of menuData) {
      for (const item of category.items) {
        if (message.toLowerCase().includes(item.name.toLowerCase())) {
          itemFound = item;
          break;
        }
      }
      if (itemFound) break;
    }

    if (itemFound) {
      const existingItem = orderState.items.find(i => i.name === itemFound.name);
      const isModification = /change|update|instead|modify/i.test(message);
      const isRemoval = /remove|delete|cancel|take off/i.test(message);

      if (existingItem && isRemoval) {
        const qtyMatch = message.match(/\\b(\\d+)\\b/);
        if (qtyMatch) {
          const qtyToRemove = parseInt(qtyMatch[1], 10);
          if (qtyToRemove >= existingItem.quantity) {
            orderState.items = orderState.items.filter(i => i.name !== itemFound.name);
            botResponse = `I've removed the ${itemFound.name} from your order.`;
          } else {
            existingItem.quantity -= qtyToRemove;
            botResponse = `I've reduced the quantity of ${itemFound.name} by ${qtyToRemove}.`;
          }
        } else {
          orderState.items = orderState.items.filter(i => i.name !== itemFound.name);
          botResponse = `I've removed the ${itemFound.name} from your order.`;
        }
      } else if (existingItem && isModification) {
        const qtyMatch = message.match(/\\b(\\d+)\\b/);
        if (qtyMatch) {
          existingItem.quantity = parseInt(qtyMatch[1], 10);
          botResponse = `Updated your ${itemFound.name} quantity to ${existingItem.quantity}.`;
        } else {
          const optionsMatch = message.match(/(?:with|add)\\s+([^.,?!]+)/i);
          if (optionsMatch) {
            const newOption = optionsMatch[1].trim();
            if (!existingItem.options.includes(newOption)) {
              existingItem.options.push(newOption);
            }
            botResponse = `Added ${newOption} to your ${itemFound.name}.`;
          } else {
            botResponse = `I see you want to modify your ${itemFound.name}. Could you please specify the quantity or customization?`;
          }
        }
      } else {
        if (existingItem) {
          existingItem.quantity += 1;
        } else {
          orderState.items.push({
            name: itemFound.name,
            quantity: 1,
            price: itemFound.price,
            options: []
          });
        }
        botResponse = `Great choice! I've added a ${itemFound.name} to your order.`;
      }

      const totals = calculateOrderTotal(orderState, menuData);
      orderState.total = totals.finalTotal;
      if (botResponse.includes('Added') || botResponse.includes('Updated') || botResponse.includes('removed') || botResponse.includes('reduced')) {
        botResponse += ` Your current total (incl. tax) is $${orderState.total.toFixed(2)}. Anything else?`;
      }
    } else {
      if (/checkout|finish|place order|confirm order/i.test(message)) {
        if (orderState.items.length === 0) {
          botResponse = "Your cart is empty! Please add some items before checking out.";
        } else if (!orderState.orderType) {
          botResponse = "Would you like this order for pickup or delivery?";
        } else if (orderState.orderType === 'pickup') {
          if (!orderState.customerDetails.name) {
            botResponse = "I'd be happy to process that for you. First, could you please tell me your name?";
          } else if (!orderState.pickupTime) {
            botResponse = `Thanks, ${orderState.customerDetails.name}! Would you like to set a specific pickup time, or just as soon as possible?`;
          } else {
            const totals = calculateOrderTotal(orderState, menuData);
            const itemSummary = orderState.items
              .map(i => `- ${i.quantity}x ${i.name}${i.options.length > 0 ? ` (${i.options.join(', ')})` : ''}`)
              .join('\\n');
            botResponse = `Ready to finalize your order!\\n\\n` +
                           `Order Summary:\\n${itemSummary}\\n` +
                           `Customer: ${orderState.customerDetails.name}\\n` +
                           `Pickup Time: ${orderState.pickupTime}\\n` +
                           `Total: $${totals.finalTotal.toFixed(2)}\\n\\n` +
                           `Shall I confirm the order?`;
          }
        } else if (orderState.orderType === 'delivery') {
          if (!orderState.customerDetails.name) {
            botResponse = "I can arrange delivery for you! First, could you please tell me your name?";
          } else if (!orderState.customerDetails.phone) {
            botResponse = `Thanks, ${orderState.customerDetails.name}. What is your phone number for the delivery driver?`;
          } else if (!orderState.customerDetails.address) {
            botResponse = "And what is the full delivery address?";
          } else if (!orderState.customerDetails.unit) {
            botResponse = `Got it. Is there an apartment, unit, or suite number we should know about? (You can say 'none').`;
          } else if (!orderState.customerDetails.instructions) {
            botResponse = "Lastly, any specific delivery instructions for the driver?";
          } else if (!orderState.deliveryConfirmed) {
            const fullAddress = `${orderState.customerDetails.address}${orderState.customerDetails.unit !== 'None' ? `, ${orderState.customerDetails.unit}` : ''}`;
            botResponse = `Please confirm your delivery address:\\n\\n${fullAddress}\\n\\nIs this correct? (Yes/No)`;
          } else {
            const totals = calculateOrderTotal(orderState, menuData);
            const itemSummary = orderState.items
              .map(i => `- ${i.quantity}x ${i.name}${i.options.length > 0 ? ` (${i.options.join(', ')})` : ''}`)
              .join('\\n');
            const fullAddress = `${orderState.customerDetails.address}${orderState.customerDetails.unit !== 'None' ? `, ${orderState.customerDetails.unit}` : ''}`;
            botResponse = `Ready to finalize your delivery!\\n\\n` +
                           `Order Summary:\\n${itemSummary}\\n` +
                           `Customer: ${orderState.customerDetails.name}\\n` +
                           `Phone: ${orderState.customerDetails.phone}\\n` +
                           `Address: ${fullAddress}\\n` +
                           `Instructions: ${orderState.customerDetails.instructions}\\n` +
                           `Total: $${totals.finalTotal.toFixed(2)}\\n\\n` +
                           `Shall I confirm the order?`;
          }
        } else {
          botResponse = "Please specify if you'd like pickup or delivery.";
        }
      } else if (/yes|correct|that is right|confirm|place it/i.test(message)) {
        // Case 1: Address confirmation for delivery
        if (orderState.orderType === 'delivery' && !orderState.deliveryConfirmed) {
          orderState.deliveryConfirmed = true;
          botResponse = `Thank you! Your address is confirmed. Total is $${orderState.total.toFixed(2)}. Shall I place the order now?`;
        }
        // Case 2: Final Order confirmation
        else if (orderState.items.length > 0 && (
          (orderState.orderType === 'pickup' && orderState.customerDetails.name && orderState.pickupTime) ||
          (orderState.orderType === 'delivery' && orderState.deliveryConfirmed)
        )) {
          // Save to orders.json
          const orderId = crypto.randomUUID();
          const finalOrder = {
            orderId,
            timestamp: new Date().toISOString(),
            status: 'confirmed',
            ...orderState
          };

          const ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
          const allOrders = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
          allOrders.push(finalOrder);
          fs.writeFileSync(ordersPath, JSON.stringify(allOrders, null, 2));

          botResponse = `Order confirmed! Your Order ID is ${orderId}. We'll have that ready for you soon. Thank you for choosing NetCafe! ☕`;

          // Clear order state for this session
          orders.delete(sessionId);
        } else {
          botResponse = "I'm not sure what you're confirming. Please let me know if you'd like to checkout!";
        }
      } else if (/no|wrong|incorrect/i.test(message) && orderState.orderType === 'delivery' && !orderState.deliveryConfirmed) {
        orderState.customerDetails.address = '';
        orderState.customerDetails.unit = '';
        botResponse = "I'm sorry about that. Let's fix it. What is the correct full delivery address?";
      } else if (/pickup|delivery|dine-in|takeaway/i.test(message)) {
        if (/pickup|takeaway/i.test(message)) {
          orderState.orderType = 'pickup';
          botResponse = "Great, a pickup order! Could you please tell me your name?";
        } else if (/delivery/i.test(message)) {
          orderState.orderType = 'delivery';
          botResponse = "Delivery it is! Could you please tell me your name?";
        }
      } else if (/my name is|i am|call me/i.test(message)) {
        const nameMatch = message.match(/(?:my name is|i am|call me)\\s+([^.,?!]+)/i);
        if (nameMatch) {
          orderState.customerDetails.name = nameMatch[1].trim();
          if (orderState.orderType === 'delivery') {
            botResponse = `Nice to meet you, ${orderState.customerDetails.name}! What is your phone number for the delivery driver?`;
          } else {
            botResponse = `Nice to meet you, ${orderState.customerDetails.name}! Would you like to set a pickup time, or just as soon as possible?`;
          }
        } else {
          botResponse = "I didn't quite catch your name. Could you please tell it to me again?";
        }
      } else if (/pickup at|time is|at\\s+\\d{1,2}:\\d{2}/i.test(message)) {
        const timeMatch = message.match(/(\\d{1,2}:\\d{2}\\s*(?:am|pm)?)/i);
        if (timeMatch) {
          orderState.pickupTime = timeMatch[1].trim();
          botResponse = `Got it! Pickup set for ${orderState.pickupTime}.`;
        } else {
          botResponse = "I couldn't quite catch the time. Please specify a time (e.g., 10:30 am).";
        }
      } else if (orderState.orderType === 'delivery' && !orderState.customerDetails.phone) {
        orderState.customerDetails.phone = message.trim();
        botResponse = `Thanks. Now, what is the full delivery address?`;
      } else if (orderState.orderType === 'delivery' && orderState.customerDetails.phone && !orderState.customerDetails.address) {
        orderState.customerDetails.address = message.trim();
        botResponse = `Got it. Is there an apartment, unit, or suite number? (You can say 'none').`;
      } else if (orderState.orderType === 'delivery' && orderState.customerDetails.address && !orderState.customerDetails.unit) {
        if (/none|no|n\\/a/i.test(message)) {
          orderState.customerDetails.unit = 'None';
          botResponse = "Thanks. Any specific delivery instructions for the driver?";
        } else {
          orderState.customerDetails.unit = message.trim();
          botResponse = "Thanks. Any specific delivery instructions for the driver?";
        }
      } else if (orderState.orderType === 'delivery' && orderState.customerDetails.unit && !orderState.customerDetails.instructions) {
        orderState.customerDetails.instructions = message.trim();
        botResponse = `Everything is set! Your delivery for ${orderState.customerDetails.name} to ${orderState.customerDetails.address} ${orderState.customerDetails.unit !== 'None' ? orderState.customerDetails.unit : ''} is ready. Total: $${orderState.total.toFixed(2)}. Confirm order?`;
      } else if (/summary|what is in my order|current order|my cart/i.test(message)) {
        if (orderState.items.length === 0) {
          botResponse = "Your order is currently empty. What can I get for you?";
        } else {
          const summary = orderState.items
            .map(i => `${i.quantity}x ${i.name}${i.options.length > 0 ? ` (with ${i.options.join(', ')})` : ''}`)
            .join('\\n');
          botResponse = `Here is your current order:\\n${summary}\\n\\nTotal: $${orderState.total.toFixed(2)}`;
        }
      } else if (/promo|discount|coupon|promotion/i.test(message)) {
        const promoPath = path.join(__dirname, '..', 'data', 'promotions.json');
        const promotions = JSON.parse(fs.readFileSync(promoPath, 'utf8'));

        const codeMatch = message.match(/\\b([A-Z0-9_]{4,})\\b/);
        if (codeMatch) {
          const code = codeMatch[1].toUpperCase();
          const promo = promotions.find(p => p.code === code);

          if (!promo || !promo.active) {
            botResponse = `I'm sorry, the code ${code} is either invalid or inactive.`;
          } else {
            let eligible = true;
            if (promo.rules.min_order_value && orderState.total < promo.rules.min_order_value) {
              eligible = false;
              botResponse = `The code ${code} requires a minimum order of $${promo.rules.min_order_value.toFixed(2)}.`;
            }
            if (promo.rules.required_items) {
              const hasItems = promo.rules.required_items.every(req =>
                orderState.items.some(i => i.name.toLowerCase() === req.toLowerCase())
              );
              if (!hasItems) {
                eligible = false;
                botResponse = `The code ${code} requires the following items: ${promo.rules.required_items.join(', ')}.`;
              }
            }

            if (eligible) {
              orderState.promotion = code;
              const totals = calculateOrderTotal(orderState, menuData);
              orderState.total = totals.finalTotal;
              botResponse = `Success! Promo code ${code} applied. Your new total is $${orderState.total.toFixed(2)}.`;
            }
          }
        } else {
          const eligiblePromos = promotions.filter(p => {
            if (!p.active) return false;
            if (p.rules.min_order_value && orderState.total < p.rules.min_order_value) return false;
            if (p.rules.required_items && !p.rules.required_items.every(req =>
              orderState.items.some(i => i.name.toLowerCase() === req.toLowerCase())
            )) return false;
            return true;
          });

          if (eligiblePromos.length > 0) {
            const promoList = eligiblePromos.map(p => `${p.code} (${p.description})`).join('\\n');
            botResponse = `I have some active promotions you might be eligible for:\\n${promoList}\\n\\nJust tell me the code to apply it!`;
          } else {
            botResponse = "I don't have any active promotions for your current order right now.";
          }
        }
      } else if (/menu|show menu|what is on the menu|list items/i.test(message)) {
        const menuList = menuData.map(category => {
          const items = category.items.map(i => `${i.name} ($${i.price.toFixed(2)})`).join('\\n- ');
          return `*${category.category}*:\\n- ${items}`;
        }).join('\\n\\n');
        botResponse = `Here is our delicious menu!\\n\\n${menuList}\\n\\nWhat can I get for you? ☕`;
      } else if (/recommend|suggestion|what do you suggest|something good/i.test(message)) {
        const currentItemNames = orderState.items.map(i => i.name.toLowerCase());
        const allItems = menuData.flatMap(cat => cat.items);
        const availableItems = allItems.filter(i => !currentItemNames.includes(i.name.toLowerCase()));

        if (availableItems.length > 0) {
          const shuffled = availableItems.sort(() => 0.5 - Math.random());
          const selected = shuffled.slice(0, 2);
          const recs = selected.map(i => `${i.name} ($${i.price.toFixed(2)})`).join(' or ');
          botResponse = `If you're looking for a suggestion, you might like the ${recs}. Would any of those sound good?`;
        } else {
          botResponse = "You've tried everything on our menu! Is there anything else I can help you with?";
        }
      } else {
        botResponse = `I'm sorry, I didn't recognize any menu items in your message. Would you like to see the menu?`;
      }
    }

    orders.set(sessionId, orderState);

    res.json({
      reply: botResponse,
      history: [...history, { role: 'user', content: message }, { role: 'bot', content: botResponse }],
      orderState
    });
  } catch (error) {
    console.error('Chat Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`CafeBot Backend running on http://localhost:${PORT}`);
});
('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Simple configuration for taxes and fees
const CONFIG = {
  TAX_RATE: 0.08, // 8%
  DELIVERY_FEE: 5.00
};

// Session-based order storage (In-memory)
const orders = new Map();

/**
 * Helper to find a menu item by name
 */
function findMenuItem(menuData, itemName) {
  for (const category of menuData) {
    const item = category.items.find(i => i.name.toLowerCase() === itemName.toLowerCase());
    if (item) return item;
  }
  return null;
}

/**
 * Calculates the deterministic total based on menu data and current order state
 */
function calculateOrderTotal(orderState, menuData) {
  let subtotal = 0;
  orderState.items.forEach(item => {
    const menuItem = findMenuItem(menuData, item.name);
    if (menuItem) {
      subtotal += menuItem.price * item.quantity;
    }
  });

  let discount = 0;
  if (orderState.promotion) {
    const promoPath = path.join(__dirname, '..', 'data', 'promotions.json');
    const promotions = JSON.parse(fs.readFileSync(promoPath, 'utf8'));
    const promo = promotions.find(p => p.code === orderState.promotion);

    if (promo && promo.active) {
      if (promo.discount_type === 'percentage') {
        discount = subtotal * (promo.value / 100);
      } else if (promo.discount_type === 'fixed') {
        discount = promo.value;
      }
    }
  }

  let total = subtotal - discount;

  if (orderState.orderType === 'delivery') {
    total += CONFIG.DELIVERY_FEE;
  }

  const tax = total * CONFIG.TAX_RATE;
  total += tax;

  return {
    subtotal: Math.max(0, subtotal),
    discount: Math.max(0, discount),
    deliveryFee: orderState.orderType === 'delivery' ? CONFIG.DELIVERY_FEE : 0,
    tax: Math.max(0, tax),
    finalTotal: Math.max(0, total)
  };
}

/**
 * POST /api/chat
 * Handles customer messages and returns bot responses.
 * Body: { message: string, history: Array, sessionId: string }
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, sessionId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required for order tracking' });
    }

    const promptPath = path.join(__dirname, '..', 'prompts', 'system-prompt.md');
    const systemPrompt = fs.readFileSync(promptPath, 'utf8');

    const menuPath = path.join(__dirname, '..', 'data', 'menu.json');
    const menuData = JSON.parse(fs.readFileSync(menuPath, 'utf8'));

    let orderState = orders.get(sessionId) || {
      items: [],
      orderType: null,
      customerDetails: {},
      promotion: null,
      total: 0,
      confirmation: false,
      status: 'pending',
      deliveryConfirmed: false
    };

    let botResponse = "";
    let itemFound = null;

    for (const category of menuData) {
      for (const item of category.items) {
        if (message.toLowerCase().includes(item.name.toLowerCase())) {
          itemFound = item;
          break;
        }
      }
      if (itemFound) break;
    }

    if (itemFound) {
      const existingItem = orderState.items.find(i => i.name === itemFound.name);
      const isModification = /change|update|instead|modify/i.test(message);
      const isRemoval = /remove|delete|cancel|take off/i.test(message);

      if (existingItem && isRemoval) {
        const qtyMatch = message.match(/\\b(\\d+)\\b/);
        if (qtyMatch) {
          const qtyToRemove = parseInt(qtyMatch[1], 10);
          if (qtyToRemove >= existingItem.quantity) {
            orderState.items = orderState.items.filter(i => i.name !== itemFound.name);
            botResponse = `I've removed the ${itemFound.name} from your order.`;
          } else {
            existingItem.quantity -= qtyToRemove;
            botResponse = `I've reduced the quantity of ${itemFound.name} by ${qtyToRemove}.`;
          }
        } else {
          orderState.items = orderState.items.filter(i => i.name !== itemFound.name);
          botResponse = `I've removed the ${itemFound.name} from your order.`;
        }
      } else if (existingItem && isModification) {
        const qtyMatch = message.match(/\\b(\\d+)\\b/);
        if (qtyMatch) {
          existingItem.quantity = parseInt(qtyMatch[1], 10);
          botResponse = `Updated your ${itemFound.name} quantity to ${existingItem.quantity}.`;
        } else {
          const optionsMatch = message.match(/(?:with|add)\\s+([^.,?!]+)/i);
          if (optionsMatch) {
            const newOption = optionsMatch[1].trim();
            if (!existingItem.options.includes(newOption)) {
              existingItem.options.push(newOption);
            }
            botResponse = `Added ${newOption} to your ${itemFound.name}.`;
          } else {
            botResponse = `I see you want to modify your ${itemFound.name}. Could you please specify the quantity or customization?`;
          }
        }
      } else {
        if (existingItem) {
          existingItem.quantity += 1;
        } else {
          orderState.items.push({
            name: itemFound.name,
            quantity: 1,
            price: itemFound.price,
            options: []
          });
        }
        botResponse = `Great choice! I've added a ${itemFound.name} to your order.`;
      }

      const totals = calculateOrderTotal(orderState, menuData);
      orderState.total = totals.finalTotal;
      if (botResponse.includes('Added') || botResponse.includes('Updated') || botResponse.includes('removed') || botResponse.includes('reduced')) {
        botResponse += ` Your current total (incl. tax) is $${orderState.total.toFixed(2)}. Anything else?`;
      }
    } else {
      if (/checkout|finish|place order|confirm order/i.test(message)) {
        if (orderState.items.length === 0) {
          botResponse = "Your cart is empty! Please add some items before checking out.";
        } else if (!orderState.orderType) {
          botResponse = "Would you like this order for pickup or delivery?";
        } else if (orderState.orderType === 'pickup') {
          if (!orderState.customerDetails.name) {
            botResponse = "I'd be happy to process that for you. First, could you please tell me your name?";
          } else if (!orderState.pickupTime) {
            botResponse = `Thanks, ${orderState.customerDetails.name}! Would you like to set a specific pickup time, or just as soon as possible?`;
          } else {
            const totals = calculateOrderTotal(orderState, menuData);
            const itemSummary = orderState.items
              .map(i => `- ${i.quantity}x ${i.name}${i.options.length > 0 ? ` (${i.options.join(', ')})` : ''}`)
              .join('\\n');
            botResponse = `Ready to finalize your order!\\n\\n` +
                           `Order Summary:\\n${itemSummary}\\n` +
                           `Customer: ${orderState.customerDetails.name}\\n` +
                           `Pickup Time: ${orderState.pickupTime}\\n` +
                           `Total: $${totals.finalTotal.toFixed(2)}\\n\\n` +
                           `Shall I confirm the order?`;
          }
        } else if (orderState.orderType === 'delivery') {
          if (!orderState.customerDetails.name) {
            botResponse = "I can arrange delivery for you! First, could you please tell me your name?";
          } else if (!orderState.customerDetails.phone) {
            botResponse = `Thanks, ${orderState.customerDetails.name}. What is your phone number for the delivery driver?`;
          } else if (!orderState.customerDetails.address) {
            botResponse = "And what is the full delivery address?";
          } else if (!orderState.customerDetails.unit) {
            botResponse = `Got it. Is there an apartment, unit, or suite number we should know about? (You can say 'none').`;
          } else if (!orderState.customerDetails.instructions) {
            botResponse = "Lastly, any specific delivery instructions for the driver?";
          } else if (!orderState.deliveryConfirmed) {
            const fullAddress = `${orderState.customerDetails.address}${orderState.customerDetails.unit !== 'None' ? `, ${orderState.customerDetails.unit}` : ''}`;
            botResponse = `Please confirm your delivery address:\\n\\n${fullAddress}\\n\\nIs this correct? (Yes/No)`;
          } else {
            const totals = calculateOrderTotal(orderState, menuData);
            const itemSummary = orderState.items
              .map(i => `- ${i.quantity}x ${i.name}${i.options.length > 0 ? ` (${i.options.join(', ')})` : ''}`)
              .join('\\n');
            const fullAddress = `${orderState.customerDetails.address}${orderState.customerDetails.unit !== 'None' ? `, ${orderState.customerDetails.unit}` : ''}`;
            botResponse = `Ready to finalize your delivery!\\n\\n` +
                           `Order Summary:\\n${itemSummary}\\n` +
                           `Customer: ${orderState.customerDetails.name}\\n` +
                           `Phone: ${orderState.customerDetails.phone}\\n` +
                           `Address: ${fullAddress}\\n` +
                           `Instructions: ${orderState.customerDetails.instructions}\\n` +
                           `Total: $${totals.finalTotal.toFixed(2)}\\n\\n` +
                           `Shall I confirm the order?`;
          }
        } else {
          botResponse = "Please specify if you'd like pickup or delivery.";
        }
      } else if (/yes|correct|that is right|confirm|place it/i.test(message)) {
        // Case 1: Address confirmation for delivery
        if (orderState.orderType === 'delivery' && !orderState.deliveryConfirmed) {
          orderState.deliveryConfirmed = true;
          botResponse = `Thank you! Your address is confirmed. Total is $${orderState.total.toFixed(2)}. Shall I place the order now?`;
        }
        // Case 2: Final Order confirmation
        else if (orderState.items.length > 0 && (
          (orderState.orderType === 'pickup' && orderState.customerDetails.name && orderState.pickupTime) ||
          (orderState.orderType === 'delivery' && orderState.deliveryConfirmed)
        )) {
          // Save to orders.json
          const orderId = crypto.randomUUID();
          const finalOrder = {
            orderId,
            timestamp: new Date().toISOString(),
            status: 'confirmed',
            ...orderState
          };

          const ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
          const allOrders = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
          allOrders.push(finalOrder);
          fs.writeFileSync(ordersPath, JSON.stringify(allOrders, null, 2));

          botResponse = `Order confirmed! Your Order ID is ${orderId}. We'll have that ready for you soon. Thank you for choosing NetCafe! ☕`;

          // Clear order state for this session
          orders.delete(sessionId);
        } else {
          botResponse = "I'm not sure what you're confirming. Please let me know if you'd like to checkout!";
        }
      } else if (/no|wrong|incorrect/i.test(message) && orderState.orderType === 'delivery' && !orderState.deliveryConfirmed) {
        orderState.customerDetails.address = '';
        orderState.customerDetails.unit = '';
        botResponse = "I'm sorry about that. Let's fix it. What is the correct full delivery address?";
      } else if (/pickup|delivery|dine-in|takeaway/i.test(message)) {
        if (/pickup|takeaway/i.test(message)) {
          orderState.orderType = 'pickup';
          botResponse = "Great, a pickup order! Could you please tell me your name?";
        } else if (/delivery/i.test(message)) {
          orderState.orderType = 'delivery';
          botResponse = "Delivery it is! Could you please tell me your name?";
        }
      } else if (/my name is|i am|call me/i.test(message)) {
        const nameMatch = message.match(/(?:my name is|i am|call me)\\s+([^.,?!]+)/i);
        if (nameMatch) {
          orderState.customerDetails.name = nameMatch[1].trim();
          if (orderState.orderType === 'delivery') {
            botResponse = `Nice to meet you, ${orderState.customerDetails.name}! What is your phone number for the delivery driver?`;
          } else {
            botResponse = `Nice to meet you, ${orderState.customerDetails.name}! Would you like to set a pickup time, or just as soon as possible?`;
          }
        } else {
          botResponse = "I didn't quite catch your name. Could you please tell it to me again?";
        }
      } else if (/pickup at|time is|at\\s+\\d{1,2}:\\d{2}/i.test(message)) {
        const timeMatch = message.match(/(\\d{1,2}:\\d{2}\\s*(?:am|pm)?)/i);
        if (timeMatch) {
          orderState.pickupTime = timeMatch[1].trim();
          botResponse = `Got it! Pickup set for ${orderState.pickupTime}.`;
        } else {
          botResponse = "I couldn't quite catch the time. Please specify a time (e.g., 10:30 am).";
        }
      } else if (orderState.orderType === 'delivery' && !orderState.customerDetails.phone) {
        orderState.customerDetails.phone = message.trim();
        botResponse = `Thanks. Now, what is the full delivery address?`;
      } else if (orderState.orderType === 'delivery' && orderState.customerDetails.phone && !orderState.customerDetails.address) {
        orderState.customerDetails.address = message.trim();
        botResponse = `Got it. Is there an apartment, unit, or suite number? (You can say 'none').`;
      } else if (orderState.orderType === 'delivery' && orderState.customerDetails.address && !orderState.customerDetails.unit) {
        if (/none|no|n\\/a/i.test(message)) {
          orderState.customerDetails.unit = 'None';
          botResponse = "Thanks. Any specific delivery instructions for the driver?";
        } else {
          orderState.customerDetails.unit = message.trim();
          botResponse = "Thanks. Any specific delivery instructions for the driver?";
        }
      } else if (orderState.orderType === 'delivery' && orderState.customerDetails.unit && !orderState.customerDetails.instructions) {
        orderState.customerDetails.instructions = message.trim();
        botResponse = `Everything is set! Your delivery for ${orderState.customerDetails.name} to ${orderState.customerDetails.address} ${orderState.customerDetails.unit !== 'None' ? orderState.customerDetails.unit : ''} is ready. Total: $${orderState.total.toFixed(2)}. Confirm order?`;
      } else if (/summary|what is in my order|current order|my cart/i.test(message)) {
        if (orderState.items.length === 0) {
          botResponse = "Your order is currently empty. What can I get for you?";
        } else {
          const summary = orderState.items
            .map(i => `${i.quantity}x ${i.name}${i.options.length > 0 ? ` (with ${i.options.join(', ')})` : ''}`)
            .join('\\n');
          botResponse = `Here is your current order:\\n${summary}\\n\\nTotal: $${orderState.total.toFixed(2)}`;
        }
      } else if (/promo|discount|coupon|promotion/i.test(message)) {
        const promoPath = path.join(__dirname, '..', 'data', 'promotions.json');
        const promotions = JSON.parse(fs.readFileSync(promoPath, 'utf8'));

        const codeMatch = message.match(/\\b([A-Z0-9_]{4,})\\b/);
        if (codeMatch) {
          const code = codeMatch[1].toUpperCase();
          const promo = promotions.find(p => p.code === code);

          if (!promo || !promo.active) {
            botResponse = `I'm sorry, the code ${code} is either invalid or inactive.`;
          } else {
            let eligible = true;
            if (promo.rules.min_order_value && orderState.total < promo.rules.min_order_value) {
              eligible = false;
              botResponse = `The code ${code} requires a minimum order of $${promo.rules.min_order_value.toFixed(2)}.`;
            }
            if (promo.rules.required_items) {
              const hasItems = promo.rules.required_items.every(req =>
                orderState.items.some(i => i.name.toLowerCase() === req.toLowerCase())
              );
              if (!hasItems) {
                eligible = false;
                botResponse = `The code ${code} requires the following items: ${promo.rules.required_items.join(', ')}.`;
              }
            }

            if (eligible) {
              orderState.promotion = code;
              const totals = calculateOrderTotal(orderState, menuData);
              orderState.total = totals.finalTotal;
              botResponse = `Success! Promo code ${code} applied. Your new total is $${orderState.total.toFixed(2)}.`;
            }
          }
        } else {
          const eligiblePromos = promotions.filter(p => {
            if (!p.active) return false;
            if (p.rules.min_order_value && orderState.total < p.rules.min_order_value) return false;
            if (p.rules.required_items && !p.rules.required_items.every(req =>
              orderState.items.some(i => i.name.toLowerCase() === req.toLowerCase())
            )) return false;
            return true;
          });

          if (eligiblePromos.length > 0) {
            const promoList = eligiblePromos.map(p => `${p.code} (${p.description})`).join('\\n');
            botResponse = `I have some active promotions you might be eligible for:\\n${promoList}\\n\\nJust tell me the code to apply it!`;
          } else {
            botResponse = "I don't have any active promotions for your current order right now.";
          }
        }
      } else if (/menu|show menu|what is on the menu|list items/i.test(message)) {
        const menuList = menuData.map(category => {
          const items = category.items.map(i => `${i.name} ($${i.price.toFixed(2)})`).join('\\n- ');
          return `*${category.category}*:\\n- ${items}`;
        }).join('\\n\\n');
        botResponse = `Here is our delicious menu!\\n\\n${menuList}\\n\\nWhat can I get for you? ☕`;
      } else if (/recommend|suggestion|what do you suggest|something good/i.test(message)) {
        const currentItemNames = orderState.items.map(i => i.name.toLowerCase());
        const allItems = menuData.flatMap(cat => cat.items);
        const availableItems = allItems.filter(i => !currentItemNames.includes(i.name.toLowerCase()));

        if (availableItems.length > 0) {
          const shuffled = availableItems.sort(() => 0.5 - Math.random());
          const selected = shuffled.slice(0, 2);
          const recs = selected.map(i => `${i.name} ($${i.price.toFixed(2)})`).join(' or ');
          botResponse = `If you're looking for a suggestion, you might like the ${recs}. Would any of those sound good?`;
        } else {
          botResponse = "You've tried everything on our menu! Is there anything else I can help you with?";
        }
      } else {
        botResponse = `I'm sorry, I didn't recognize any menu items in your message. Would you like to see the menu?`;
      }
    }

    orders.set(sessionId, orderState);

    res.json({
      reply: botResponse,
      history: [...history, { role: 'user', content: message }, { role: 'bot', content: botResponse }],
      orderState
    });
  } catch (error) {
    console.error('Chat Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`CafeBot Backend running on http://localhost:${PORT}`);
});
