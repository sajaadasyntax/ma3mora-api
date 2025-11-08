import { PrismaClient, Section, CustomerType, PaymentStatus, DeliveryStatus, PaymentMethod, Prisma, Role, ProcOrderStatus, BalanceScope } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Comprehensive Seed Script - Combines all seed scripts
 * 
 * This script seeds:
 * 1. Users (all roles with password: password123)
 * 2. Warehouses (Main, Sub, Bakery warehouses)
 * 3. Items and Stock (Grocery and Bakery)
 * 4. Customers (Grocery, Bakery, Agent Retail)
 * 5. Suppliers
 * 6. Sales Invoices (delivered, unpaid)
 * 7. Procurement Orders (received, unpaid)
 * 8. Inbound Debts
 */

// ============================================
// USER DATA
// ============================================
const usersData = [
  { username: 'procurement', role: Role.PROCUREMENT },
  { username: 'sales_grocery', role: Role.SALES_GROCERY },
  { username: 'sales_bakery', role: Role.SALES_BAKERY },
  { username: 'agent_grocery', role: 'AGENT_GROCERY' as Role },
  { username: 'agent_bakery', role: 'AGENT_BAKERY' as Role },
  { username: 'inventory', role: Role.INVENTORY },
  { username: 'accountant', role: Role.ACCOUNTANT },
  { username: 'auditor', role: Role.AUDITOR },
  { username: 'manager', role: Role.MANAGER },
];

// ============================================
// WAREHOUSE DATA
// ============================================

// Main Warehouse Grocery Stock
const mainWarehouseGroceryData = `
حلواني باسطة	0	 60,000 	
سيقا الاصلي 	1405	 50,000 	
الاول	-501	 20,500 	
مخصوص	2	 23,000 	
سمولينا	316	 32,000 	
الاصلي 10 ك	247	 20,500 	
زادنا 10 ك	165	 24,000 	
معكرونة نوبو 300 جم * 30	1358	 33,000 	
شعيرية نوبو 300 جم * 30	467	 33,000 	
سكسكانية	1	 33,000 	
شعيرية نوبو 500 جم	0	 31,500 	
مكرونة نوبو 500 جم	277	 34,500 	
زيت زادنا 900 مل	26	 88,000 	
زيت زادنا 1.5 لتر	0		
زيت زادنا 18 لتر	50	 129,000 	
كابو 40 جم	68	 71,000 	
كابو 200 جم * 24	0		
كابو 200 جم * 12	59	 69,000 	
كابو 1ك	21	 160,000 	
كابو 2.25 كيلو	22	 175,000 	
سكر 5 كيلو	0	 13,500 	
بسكويت	0	 14,000 	
نودلز خضار	0	 18,500 	
نودلز فراخ	0	 18,500 	
عدس 200 جم	0	 40,500 	
عدس 1 ك	20	 48,000 	
عدس 5 كيلو	0	 15,000 	
خميرة 11 جم	205	 16,667 	
صافية 1.5 لتر	64	 9,750 	
صافية 500 مل	0	 8,750 	
صافية 600 مل	695	 8,750 	
صافية 330مل	54	 14,500 	
صافية 5لتر	80	 7,000 	
صافية 10لتر	0		
سبرايت 250 مل علب	0	 34,000 	
كولا علب 250 مل	0	 34,000 	
كولا 300 مل	0	 19,000 	
فانتا برتقال 300 مل	0	 19,000 	
سبرايت 300 مل	0	 19,000 	
كولا 1.45 لتر	0	 35,500 	
سبرايت 1.45 لتر	0	 35,500 	
فانتا برتقال 1.45 لتر	0	 35,500 	
الاصلي 10ك	0	 20,500 	
معكرونة نوبو 300 جم * 20	65	 19,000 	
خميرة بيكر دريم	16	 116,000 	
خميرة فواريس	0	 113,000 	
`;

// Sub Warehouse Grocery Stock
const subWarehouseGroceryData = `
حلواني باسطة	0	 60,700 	
سيقا الاصلي 	36	 50,000 	
الاول	52	 21,200 	
مخصوص	0	 23,700 	
سمولينا	35	 32,700 	
الاصلي 10 ك	18	 21,200 	
زادنا 10 ك	1	 24,700 	
معكرونة نوبو 300 جم * 30	30	 33,700 	
شعيرية نوبو 300 جم * 30	24	 33,700 	
سكسكانية	7	 33,700 	
شعيرية نوبو 500 جم	0	 34,000 	
مكرونة نوبو 500 جم	0	 35,200 	
زيت زادنا 900 مل	0	 88,700 	
كابو 40 جم	10	 71,700 	
كابو 200 جم * 24	0	 127,600 	
كابو 200 جم * 12	10	 69,700 	
كابو 1ك	1	 160,700 	
كابو 2.25 كيلو	8	 175,700 	
خميرة 11 جم	18	 16,784 	
صافية 1.5 لتر	0	 9,750 	
صافية 500 مل	0	 8,750 	
صافية 600 مل	0	 8,750 	
صافية 330مل	0	 14,500 	
صافية 5لتر	0	 7,000 	
صافية 10لتر	0		
معكرونة نوبو 300 جم * 20	0	 117,000 	
خميرة بيكر دريم	0	 113,000 	
خميرة فواريس	0		0
`;

// Bakery Warehouse Data
const bakeryWarehouses = [
  {
    name: 'المخزن الرئيسي',
    searchTerms: ['رئيسي', 'المخزن الرئيسي'],
    data: [
      { name: 'البلدي', stock: 1022, wholesalePrice: 56500 },
      { name: 'الالي', stock: 604, wholesalePrice: 58000 },
      { name: 'الوافر', stock: 0, wholesalePrice: 0 },
      { name: 'خميرة بيضاء', stock: 235, wholesalePrice: 125000 },
      { name: 'خميرة فكتوريا', stock: 741, wholesalePrice: 120000 },
      { name: 'خميرة دريم', stock: 0, wholesalePrice: 0 },
      { name: 'خميرة فواريس', stock: 12, wholesalePrice: 113000 },
      { name: 'خميرة بيكر دريم', stock: 0, wholesalePrice: 116000 },
      { name: 'الأصلي', stock: 1759, wholesalePrice: 52200 },
      { name: 'سمولينا 10 ك', stock: 0, wholesalePrice: 0 },
      { name: 'حلواني باسطة 25 ك', stock: 0, wholesalePrice: 0 },
    ],
  },
  {
    name: 'المخزن الفرعي',
    searchTerms: ['فرعي', 'المخزن الفرعي'],
    data: [
      { name: 'البلدي', stock: 0, wholesalePrice: 56500 },
      { name: 'الالي', stock: 1, wholesalePrice: 58000 },
      { name: 'الوافر', stock: 0, wholesalePrice: 0 },
      { name: 'خميرة بيضاء', stock: 48, wholesalePrice: 125000 },
      { name: 'خميرة فكتوريا', stock: 40, wholesalePrice: 120000 },
      { name: 'خميرة دريم', stock: 0, wholesalePrice: 113000 },
      { name: 'خميرة فواريس', stock: 3, wholesalePrice: 113000 },
      { name: 'خميرة بيكر دريم', stock: 0, wholesalePrice: 116000 },
      { name: 'الأصلي', stock: 34, wholesalePrice: 50000 },
      { name: 'سمولينا 10 ك', stock: 0, wholesalePrice: 0 },
      { name: 'حلواني باسطة 25 ك', stock: 0, wholesalePrice: 0 },
      { name: 'حلواني كيك', stock: 0, wholesalePrice: 0 },
    ],
  },
  {
    name: 'القرشي',
    searchTerms: ['قرشي', 'القرشي'],
    data: [
      { name: 'البلدي', stock: 0, wholesalePrice: 57100 },
      { name: 'الالي', stock: 384, wholesalePrice: 58600 },
      { name: 'الوافر', stock: 0, wholesalePrice: 0 },
      { name: 'خميرة بيضاء', stock: 9, wholesalePrice: 126000 },
      { name: 'خميرة فكتوريا', stock: 38, wholesalePrice: 121000 },
      { name: 'خميرة دريم', stock: 0, wholesalePrice: 114000 },
      { name: 'خميرة فواريس', stock: 25, wholesalePrice: 114000 },
      { name: 'خميرة بيكر دريم', stock: 0, wholesalePrice: 117000 },
      { name: 'الأصلي', stock: 716, wholesalePrice: 52800 },
      { name: 'سمولينا 10 ك', stock: 0, wholesalePrice: 0 },
      { name: 'حلواني باسطة 25 ك', stock: 0, wholesalePrice: 0 },
      { name: 'حلواني كيك', stock: 0, wholesalePrice: 0 },
    ],
  },
  {
    name: 'عبود',
    searchTerms: ['عبود'],
    data: [
      { name: 'الالي', stock: 50, wholesalePrice: 58000 },
      { name: 'الوافر', stock: 0, wholesalePrice: 0 },
      { name: 'خميرة بيضاء', stock: 4, wholesalePrice: 125000 },
      { name: 'خميرة فكتوريا', stock: 5, wholesalePrice: 120000 },
      { name: 'خميرة دريم', stock: 0, wholesalePrice: 0 },
      { name: 'خميرة فواريس', stock: 10, wholesalePrice: 113000 },
      { name: 'خميرة بيكر دريم', stock: 0, wholesalePrice: 116000 },
      { name: 'الأصلي', stock: 65, wholesalePrice: 52200 },
      { name: 'سمولينا 10 ك', stock: 0, wholesalePrice: 0 },
      { name: 'حلواني باسطة 25 ك', stock: 0, wholesalePrice: 0 },
      { name: 'حلواني كيك', stock: 0, wholesalePrice: 0 },
    ],
  },
  {
    name: 'معتوق',
    searchTerms: ['معتوق'],
    data: [
      { name: 'الالي', stock: 177, wholesalePrice: 58600 },
      { name: 'الوافر', stock: 0, wholesalePrice: 0 },
      { name: 'خميرة بيضاء', stock: 0, wholesalePrice: 126000 },
      { name: 'خميرة فكتوريا', stock: 67, wholesalePrice: 121000 },
      { name: 'خميرة دريم', stock: 0, wholesalePrice: 114000 },
      { name: 'خميرة فواريس', stock: 0, wholesalePrice: 114000 },
      { name: 'خميرة بيكر دريم', stock: 0, wholesalePrice: 117000 },
      { name: 'الأصلي', stock: 679, wholesalePrice: 52800 },
      { name: 'سمولينا 10 ك', stock: 0, wholesalePrice: 0 },
      { name: 'حلواني باسطة 25 ك', stock: 0, wholesalePrice: 0 },
      { name: 'حلواني كيك', stock: 0, wholesalePrice: 0 },
    ],
  },
];

// ============================================
// CUSTOMER DATA
// ============================================

// Grocery Customers
const groceryCustomers = [
  { name: 'عبد الوهاب دفع الله اب سم', amount: 19433850 },
  { name: 'بقالة البركة - يور / اب سم', amount: 1554000 },
  { name: 'اسعد الزمزمي', amount: 57750 },
  { name: 'عزالدين الحوري', amount: 33618000 },
  { name: 'اسعد مبارك', amount: 296000 },
  { name: 'مبارك الطيب', amount: 211600 },
  { name: 'خالد مدرسة المجد', amount: 488700 },
  { name: 'هيثم حمد النيل', amount: 91450 },
  { name: 'محمد عوض', amount: 730000 },
  { name: 'عابدین محمد - معتوق', amount: 5000 },
  { name: 'حسين علي', amount: 74100 },
  { name: 'اسامه ابراهیم', amount: 351500 },
  { name: 'محمد مهدي', amount: 640000 },
  { name: 'مرکز معتوق - ممدوح', amount: 16377800 },
  { name: 'مركز القرشي - عدي', amount: 31704500 },
  { name: 'علي اب رش الكريمت', amount: 1520000 },
  { name: 'عبد الرحمن عبدالله', amount: 41200 },
  { name: 'حافظ الطيب - العزازي', amount: 37420000 },
  { name: 'محمد عبدالله الحرمين', amount: 1025000 },
  { name: 'فاروق الحوري - معتوق', amount: 4375000 },
  { name: 'بقالة ام القري', amount: 1420000 },
  { name: 'مصعب ميرغني', amount: 102000 },
  { name: 'ود ابراهيم', amount: 180000 },
  { name: 'عبد العزيز اب سم', amount: 282500 },
  { name: 'منصور علي', amount: 121000 },
  { name: 'مركز الهدي', amount: 82700 },
  { name: 'جنابو بكري', amount: 30000 },
  { name: 'يوسف احمد يوسف - بنك النيل', amount: 816000 },
];

// Bakery Customers
const bakeryCustomers = [
  { name: 'عصام ود ابراهيم', amount: 24461600 },
  { name: 'موسى الصادق - الكشيف', amount: 16109600 },
  { name: 'مخبز ام القرى', amount: 40570650 },
  { name: 'مخبز الشهيد', amount: 8035800 },
  { name: 'عادل عثمان ابو شوك', amount: 13502900 },
  { name: 'محمد نصر الدين', amount: 14825000 },
  { name: 'علي صالح', amount: 7708600 },
  { name: 'موسى الصادق - لؤلؤة', amount: 20590500 },
  { name: 'احباب الرسول', amount: 1582000 },
  { name: 'ابراهيم الحبشي', amount: 16580150 },
  { name: 'عبدالمولى حسن', amount: 3900000 },
  { name: 'التوم حميدان', amount: 45421500 },
  { name: 'عوض الجيد عبود', amount: 4160000 },
  { name: 'حاتم الشايقي', amount: 5802550 },
  { name: 'محمد ابو ادريس', amount: 100000 },
  { name: 'احمد عمر بطه', amount: 14892000 },
  { name: 'احمد حسین', amount: 1325000 },
  { name: 'محمد يوسف الجوهرة', amount: 19900000 },
  { name: 'سلفيات العتالة', amount: 60000 },
  { name: 'مخبز الاحسان - حمد', amount: 1000500 },
  { name: 'خالد عبدالقادر', amount: 455000 },
  { name: 'مكاوي بورتسودان', amount: 137100 },
  { name: 'محمدين صوبان', amount: 250000 },
  { name: 'خالد مخبز دریبو', amount: 5800000 },
  { name: 'ابراهيم محمد قرية محمد زين', amount: 3525000 },
  { name: 'عادل ابراهيم', amount: 193000 },
  { name: 'مخبز الجودي - الامين موسى', amount: 1245000 },
  { name: 'احمد الريح - ابو فلج', amount: 1171500 },
  { name: 'حافظ عبدالله - الصلاة على النبي', amount: 6409500 },
  { name: 'عبدالله الامام', amount: 223000 },
  { name: 'محمد ود البحر', amount: 26460000 },
  { name: 'مهدي التوحيد - ام طلحه', amount: 193500 },
  { name: 'محمد مصطفى - الشكينيبة', amount: 198000 },
  { name: 'مدثر الفزاري', amount: 1308500 },
  { name: 'ياسر الطاهر ام طلحه', amount: 2440350 },
  { name: 'الطيب صلاح', amount: 2542500 },
  { name: 'لؤي مصطفى', amount: 1755000 },
  { name: 'فهمي طلحه ود محمود', amount: 3246000 },
  { name: 'الجيلي عبدالله', amount: 482000 },
  { name: 'هيثم حمد النيل', amount: 80000 },
  { name: 'بنج', amount: 30000 },
  { name: 'حاج علي - علي الامين', amount: 2640000 },
  { name: 'عبد العزيز بابكر - ام طلحه عمر مضوي', amount: 1782000 },
  { name: 'ابایزید عبود', amount: 7702500 },
  { name: 'ابراهیم عبود', amount: 2306000 },
  { name: 'احمد محمد حسن - الحله جديده', amount: 2850000 },
  { name: 'عصام يوسف - الحله جديده', amount: 2995500 },
  { name: 'احمد يوسف', amount: 887000 },
  { name: 'عبد العظيم عثمان حله جديده', amount: 3520500 },
  { name: 'سامي ود البحر', amount: 4060000 },
  { name: 'نادر ود حلو', amount: 1644000 },
  { name: 'عادل نادي المريخ فرم', amount: 5210200 },
  { name: 'سامى مخبز الملك 2', amount: 3525000 },
  { name: 'خالد - مدرسة المجد', amount: 174000 },
  { name: 'محمد دفع الله اب سم', amount: 150000 },
  { name: 'عمر مضوي', amount: 30000 },
  { name: 'حساب المخبز محمد + عمر', amount: 18682000 },
  { name: 'مركز معتوق - ممدوح', amount: 167349800 },
  { name: 'مركز القرشي - عدي', amount: 105662000 },
  { name: 'مركز الهدى', amount: 2144450 },
  { name: 'مجدي الطيب', amount: 25078600 },
  { name: 'محمد عادل - نادي المريخ', amount: 3000000 },
  { name: 'خالد يوسف', amount: 1000000 },
  { name: 'مركز القرشي - محمد علي', amount: 71045660 },
];

// Agent Retail Customers
const agentRetailCustomers = [
  { name: 'احمد عبد الحفيظ مندوب القطاعي', amount: 1500900 },
  { name: 'عماد النخيل', amount: 300000 },
  { name: 'مهدى المستشفى', amount: 447500 },
  { name: 'سوبر الميناء البري', amount: 592500 },
  { name: 'القوس - الزعيم', amount: 463500 },
  { name: 'محمد - عربة الكابو', amount: 266250 },
  { name: 'خالد برادیس', amount: 348800 },
  { name: 'محمد - المستشفي', amount: 237500 },
  { name: 'شوقي كافتريا دبل لي', amount: 582500 },
  { name: 'حمدي المودة', amount: 495000 },
  { name: 'ياسين (سامي)', amount: 207500 },
  { name: 'علي محمد - شيش', amount: 449500 },
  { name: 'يوسف - اماسينا', amount: 427750 },
  { name: 'الشاذلي المستشفي', amount: 632500 },
  { name: 'الافريقي مصطفي', amount: 185000 },
  { name: 'احمد آدم', amount: 500000 },
  { name: 'محمد الزبير المندوب', amount: 95250 },
  { name: 'احمد مالك', amount: 2561500 },
  { name: 'محمد خليفة', amount: 804000 },
  { name: 'الرشيد صالح', amount: 2195000 },
  { name: 'معتز سالم', amount: 90700 },
  { name: 'يس المندوب', amount: 209700 },
  { name: 'سلمان بقالة', amount: 209800 },
  { name: 'عادل ابراهيم', amount: 412000 },
  { name: 'دفع الله خليفة', amount: 3605000 },
  { name: 'بدر الدین محمد سالم', amount: 1769000 },
  { name: 'الهادي حمد', amount: 245000 },
  { name: 'عثمان صوبان', amount: 246000 },
  { name: 'محمد عبد الحميد', amount: 865000 },
  { name: 'محمد جبارة', amount: 2105000 },
  { name: 'اسامه يوسف', amount: 532500 },
  { name: 'عبد المنعم الكش', amount: 921000 },
  { name: 'احمد رابح', amount: 445000 },
  { name: 'قسم جبارة', amount: 740000 },
  { name: 'الخير المدني', amount: 810000 },
  { name: 'مدثر احمد', amount: 370000 },
  { name: 'بكري دفع الله', amount: 1136000 },
  { name: 'محمد المامون', amount: 2000 },
  { name: 'يوسف الجزولي', amount: 1675000 },
  { name: 'طه معتصم', amount: 365000 },
  { name: 'علي اشهد', amount: 300000 },
  { name: 'عاصم عبد الباقي', amount: 250000 },
  { name: 'موسي عبد الباقي', amount: 1355000 },
  { name: 'خالد عمر لطفي', amount: 1155000 },
  { name: 'عبدالله ملح', amount: 1614000 },
  { name: 'البيهقي محمد النعمة', amount: 95000 },
  { name: 'محمد نادر', amount: 3000 },
  { name: 'ضياء الدين حاج على', amount: 300000 },
  { name: 'عمر آدم', amount: 2734500 },
  { name: 'ابراهيم عادل', amount: 66000 },
  { name: 'محي الدين صالح', amount: 522000 },
  { name: 'عادل حسن سالم', amount: 490000 },
  { name: 'محمد البشير', amount: 2895000 },
  { name: 'عبد الباقى عبدة', amount: 250000 },
  { name: 'عباس رابح', amount: 120000 },
  { name: 'عبدالله عمر', amount: 40000 },
  { name: 'ازرق عبدالله', amount: 2835500 },
  { name: 'نادر البشير', amount: 700000 },
  { name: 'احمد آدم', amount: 1650000 },
  { name: 'يس ود البحر', amount: 2175000 },
  { name: 'موسي سعيد', amount: 20000 },
  { name: 'ود البحر محمد احمد', amount: 9200 },
  { name: 'قرین محمد احمد', amount: 600000 },
  { name: 'عبد الباقي النور', amount: 1430000 },
  { name: 'محمد الحلبي', amount: 2705000 },
  { name: 'عصام ادم', amount: 1675000 },
  { name: 'محمد علی کنو', amount: 2310000 },
  { name: 'اولاد ابراهیم', amount: 2482000 },
  { name: 'محمد يوسف النعمة', amount: 2015000 },
  { name: 'محمد ادم', amount: 177500 },
  { name: 'محمد التهامي', amount: 1025000 },
  { name: 'محمد مصطفى البعيو', amount: 1381000 },
  { name: 'جلال بابكر', amount: 25000 },
];

// ============================================
// SUPPLIER DATA
// ============================================
const suppliersData = [
  'العهدة',
  'بحري',
  'مدني',
  'الضو العوض',
];

// ============================================
// PROCUREMENT ORDER DATA
// ============================================

// Grocery Procurement Orders
const groceryProcOrders = [
  { supplier: 'العهدة', item: 'منتجات', quantity: 23077500, amount: 23077500, date: '2024-10-23' },
  { supplier: 'العهدة', item: 'منتجات', quantity: 36122500, amount: 36122500, date: '2024-10-27' },
  { supplier: 'العهدة', item: 'الأول', quantity: 1898, amount: 35777300, date: '2024-11-03' },
  { supplier: 'العهدة', item: 'شعيرية', quantity: 1450, amount: 45457500, date: '2024-11-04' },
  { supplier: 'بحري', item: 'الأول', quantity: 1500, amount: 27225000, date: '2024-10-28' },
  { supplier: 'بحري', item: 'صافية', quantity: 11850000, amount: 11850000, date: '2024-10-28' },
  { supplier: 'بحري', item: 'الأول', quantity: 1250, amount: 22687500, date: '2024-10-29' },
  { supplier: 'بحري', item: 'الأول', quantity: 1000, amount: 18150000, date: '2024-11-05' },
  { supplier: 'بحري', item: 'سمولينا', quantity: 500, amount: 15225000, date: '2024-11-05' },
  { supplier: 'بحري', item: 'الأول', quantity: 500, amount: 9075000, date: '2024-11-05' },
  { supplier: 'مدني', item: 'منتجات', quantity: 31935000, amount: 31935000, date: '2024-10-29' },
];

// Bakery Procurement Orders
const bakeryProcOrders = [
  { supplier: 'بحري', item: 'الأصلي', quantity: 1200, amount: 63480000, date: '2024-10-12' },
  { supplier: 'بحري', item: 'الالي', quantity: 2000, amount: 117400000, date: '2024-10-18' },
  { supplier: 'بحري', item: 'الأصلي', quantity: 3000, amount: 158700000, date: '2024-10-18' },
  { supplier: 'بحري', item: 'البلدي', quantity: 2400, amount: 138600000, date: '2024-10-21' },
  { supplier: 'بحري', item: 'فواريس', quantity: 100, amount: 11200000, date: '2024-10-21' },
  { supplier: 'بحري', item: 'الالي', quantity: 305, amount: 17903500, date: '2024-10-27' },
  { supplier: 'بحري', item: 'الأصلي', quantity: 200, amount: 10580000, date: '2024-10-27' },
  { supplier: 'بحري', item: 'الالي', quantity: 1000, amount: 58700000, date: '2024-10-28' },
  { supplier: 'بحري', item: 'البلدي', quantity: 1116, amount: 64449000, date: '2024-10-29' },
  { supplier: 'بحري', item: 'الالي', quantity: 2340, amount: 137358000, date: '2024-11-01' },
  { supplier: 'بحري', item: 'الالي', quantity: 1200, amount: 70440000, date: '2024-11-04' },
  { supplier: 'بحري', item: 'البلدي', quantity: 1200, amount: 69300000, date: '2024-11-04' },
  { supplier: 'بحري', item: 'البلدي', quantity: 1200, amount: 69300000, date: '2024-11-06' },
  { supplier: 'الضو العوض', item: 'منتجات', quantity: 10000000, amount: 10000000, date: '2024-10-15' },
];

// ============================================
// INBOUND DEBTS DATA
// ============================================
const inboundDebtsData = [
  { description: 'مخزن الشارع', amount: 368714500 },
  { description: 'تعويضات 25 كيلو', amount: 34721200 },
  { description: 'ترحيل إبراهيم عبدالله - الشركة', amount: 450000 },
  { description: 'قيمة 30 الف ريال اب سم وعمر مضوي', amount: 12275000 },
];

// ============================================
// HELPER FUNCTIONS
// ============================================

function parsePastedData(data: string) {
  const lines = data
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  return lines.map((line, index) => {
    const parts = line.split(/\t|\s{2,}/).filter(p => p.trim());
    
    if (parts.length < 3) {
      return null;
    }

    const name = parts[0].trim();
    const stock = parseFloat(parts[1].replace(/,/g, '')) || 0;
    const price = parseFloat(parts[2].replace(/,/g, '').replace(/\s/g, '')) || 0;

    // Allow negative stock values (for adjustments/deficits)
    const finalStock = stock;

    return { name, stock: finalStock, wholesalePrice: price };
  }).filter(item => item !== null) as Array<{ name: string; stock: number; wholesalePrice: number }>;
}

// ============================================
// MAIN SEED FUNCTION
// ============================================

async function main() {
  console.log('🌱 Starting comprehensive seed script...\n');
  console.log('='.repeat(60));
  console.log('This will seed:');
  console.log('  1. Users (all roles)');
  console.log('  2. Warehouses');
  console.log('  3. Items and Stock');
  console.log('  4. Customers');
  console.log('  5. Suppliers');
  console.log('  6. Sales Invoices (delivered, unpaid)');
  console.log('  7. Procurement Orders (received, unpaid)');
  console.log('  8. Inbound Debts');
  console.log('='.repeat(60) + '\n');

  const passwordHash = await bcrypt.hash('password123', 10);
  const users: Record<string, any> = {};

  // ============================================
  // 1. CREATE USERS
  // ============================================
  console.log('👤 Step 1: Creating users...\n');
  for (const userData of usersData) {
    try {
      let user = await prisma.user.findFirst({
        where: { username: userData.username },
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            username: userData.username,
            passwordHash,
            role: userData.role,
          },
        });
        console.log(`  ✨ Created user: ${userData.username} (${userData.role})`);
      } else {
        // Update password to password123
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordHash },
        });
        console.log(`  ♻️  Updated user: ${userData.username} (password reset)`);
      }
      users[userData.role] = user;
    } catch (error: any) {
      if (error.message && error.message.includes('invalid input value for enum "Role"')) {
        console.log(`  ⚠️  Skipping user: ${userData.username} - Role ${userData.role} not available in database`);
        console.log(`     💡 Run this SQL on your database to add the missing roles:`);
        console.log(`        ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'AGENT_GROCERY';`);
        console.log(`        ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'AGENT_BAKERY';`);
        console.log(`     Or run: npx prisma migrate dev`);
        continue;
      }
      throw error;
    }
  }
  console.log('  ✅ Users created/updated\n');

  // ============================================
  // 2. CREATE WAREHOUSES
  // ============================================
  console.log('📦 Step 2: Creating warehouses...\n');
  const warehouses: Record<string, any> = {};

  // Main Warehouse
  let mainWarehouse = await prisma.inventory.findFirst({
    where: {
      OR: [
        { name: { contains: 'رئيسي' } },
        { name: 'المخزن الرئيسي' }
      ]
    },
  });

  if (!mainWarehouse) {
    mainWarehouse = await prisma.inventory.create({
      data: {
        name: 'المخزن الرئيسي',
        isMain: true,
      },
    });
    console.log('  ✨ Created: المخزن الرئيسي');
  } else {
    console.log('  ✅ Found: المخزن الرئيسي');
  }
  warehouses['main'] = mainWarehouse;

  // Sub Warehouse
  let subWarehouse = await prisma.inventory.findFirst({
    where: {
      OR: [
        { name: { contains: 'فرعي' } },
        { name: 'المخزن الفرعي' }
      ]
    },
  });

  if (!subWarehouse) {
    subWarehouse = await prisma.inventory.create({
      data: {
        name: 'المخزن الفرعي',
        isMain: false,
      },
    });
    console.log('  ✨ Created: المخزن الفرعي');
  } else {
    console.log('  ✅ Found: المخزن الفرعي');
  }
  warehouses['sub'] = subWarehouse;

  // Bakery Warehouses
  for (const warehouseConfig of bakeryWarehouses) {
    let warehouse = await prisma.inventory.findFirst({
      where: {
        OR: warehouseConfig.searchTerms.map(term => ({
          name: { contains: term },
        })),
      },
    });

    if (!warehouse) {
      warehouse = await prisma.inventory.create({
        data: {
          name: warehouseConfig.name,
          isMain: false,
        },
      });
      console.log(`  ✨ Created: ${warehouseConfig.name}`);
    } else {
      console.log(`  ✅ Found: ${warehouseConfig.name}`);
    }
    warehouses[warehouseConfig.name] = warehouse;
  }
  console.log('  ✅ Warehouses ready\n');

  // ============================================
  // 3. CREATE ITEMS AND STOCK
  // ============================================
  console.log('📦 Step 3: Creating items and stock...\n');

  // Main Warehouse Grocery Stock
  console.log('  Processing Main Warehouse Grocery Stock...');
  const mainGroceryData = parsePastedData(mainWarehouseGroceryData);
  for (const itemData of mainGroceryData) {
    if (itemData.stock === 0 && itemData.wholesalePrice === 0) continue;

    let item = await prisma.item.findFirst({
      where: {
        name: itemData.name,
        section: Section.GROCERY,
      },
      include: { prices: true },
    });

    if (!item) {
      const retailPrice = Math.round(itemData.wholesalePrice * 1.15);
      const agentPrice = Math.round(itemData.wholesalePrice * 1.10);
      const priceTiers: Array<{ tier: CustomerType; price: number }> = [
        { tier: CustomerType.WHOLESALE, price: itemData.wholesalePrice },
        { tier: CustomerType.RETAIL, price: retailPrice },
      ];
      // Add AGENT tier if it exists in the enum
      if ('AGENT' in CustomerType) {
        priceTiers.push({ tier: 'AGENT' as CustomerType, price: agentPrice });
      }
      
      item = await prisma.item.create({
        data: {
          name: itemData.name,
          section: Section.GROCERY,
          prices: {
            create: priceTiers,
          },
        },
        include: { prices: true },
      });
    }
    // Note: We do NOT update prices for existing items - prices should only be set when items are first created

    const existingStock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: mainWarehouse.id,
          itemId: item.id,
        },
      },
    });

    if (existingStock) {
      await prisma.inventoryStock.update({
        where: {
          inventoryId_itemId: {
            inventoryId: mainWarehouse.id,
            itemId: item.id,
          },
        },
        data: { quantity: itemData.stock },
      });
    } else {
      await prisma.inventoryStock.create({
        data: {
          inventoryId: mainWarehouse.id,
          itemId: item.id,
          quantity: itemData.stock,
        },
      });
    }
  }
  console.log(`    ✅ Processed ${mainGroceryData.length} items`);

  // Sub Warehouse Grocery Stock
  console.log('  Processing Sub Warehouse Grocery Stock...');
  const subGroceryData = parsePastedData(subWarehouseGroceryData);
  for (const itemData of subGroceryData) {
    if (itemData.stock === 0 && itemData.wholesalePrice === 0) continue;

    let item = await prisma.item.findFirst({
      where: {
        name: itemData.name,
        section: Section.GROCERY,
      },
      include: { prices: true },
    });

    if (!item) {
      const retailPrice = Math.round(itemData.wholesalePrice * 1.15);
      const agentPrice = Math.round(itemData.wholesalePrice * 1.10);
      const priceTiers: Array<{ tier: CustomerType; price: number }> = [
        { tier: CustomerType.WHOLESALE, price: itemData.wholesalePrice },
        { tier: CustomerType.RETAIL, price: retailPrice },
      ];
      // Add AGENT tier if it exists in the enum
      if ('AGENT' in CustomerType) {
        priceTiers.push({ tier: 'AGENT' as CustomerType, price: agentPrice });
      }
      
      item = await prisma.item.create({
        data: {
          name: itemData.name,
          section: Section.GROCERY,
          prices: {
            create: priceTiers,
          },
        },
        include: { prices: true },
      });
    }

    const existingStock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: subWarehouse.id,
          itemId: item.id,
        },
      },
    });

    if (existingStock) {
      await prisma.inventoryStock.update({
        where: {
          inventoryId_itemId: {
            inventoryId: subWarehouse.id,
            itemId: item.id,
          },
        },
        data: { quantity: itemData.stock },
      });
    } else {
      await prisma.inventoryStock.create({
        data: {
          inventoryId: subWarehouse.id,
          itemId: item.id,
          quantity: itemData.stock,
        },
      });
    }
  }
  console.log(`    ✅ Processed ${subGroceryData.length} items`);

  // Bakery Warehouses Stock
  console.log('  Processing Bakery Warehouses Stock...');
  for (const warehouseConfig of bakeryWarehouses) {
    const warehouse = warehouses[warehouseConfig.name];
    for (const itemData of warehouseConfig.data) {
      if (itemData.stock === 0 && itemData.wholesalePrice === 0) continue;

      let item = await prisma.item.findFirst({
        where: {
          name: itemData.name,
          section: Section.BAKERY,
        },
        include: { prices: true },
      });

      if (!item) {
        const retailPrice = Math.round(itemData.wholesalePrice * 1.15);
        const agentPrice = Math.round(itemData.wholesalePrice * 1.10);
        const priceTiers: Array<{ tier: CustomerType; price: number }> = [
          { tier: CustomerType.WHOLESALE, price: itemData.wholesalePrice },
          { tier: CustomerType.RETAIL, price: retailPrice },
        ];
        // Add AGENT tier if it exists in the enum
        if ('AGENT' in CustomerType) {
          priceTiers.push({ tier: 'AGENT' as CustomerType, price: agentPrice });
        }
        
        item = await prisma.item.create({
          data: {
            name: itemData.name,
            section: Section.BAKERY,
            prices: {
              create: priceTiers,
            },
          },
          include: { prices: true },
        });
      }
      // Note: We do NOT update prices for existing items - prices should only be set when items are first created

      const existingStock = await prisma.inventoryStock.findUnique({
        where: {
          inventoryId_itemId: {
            inventoryId: warehouse.id,
            itemId: item.id,
          },
        },
      });

      if (existingStock) {
        await prisma.inventoryStock.update({
          where: {
            inventoryId_itemId: {
              inventoryId: warehouse.id,
              itemId: item.id,
            },
          },
          data: { quantity: itemData.stock },
        });
      } else {
        await prisma.inventoryStock.create({
          data: {
            inventoryId: warehouse.id,
            itemId: item.id,
            quantity: itemData.stock,
          },
        });
      }
    }
  }
  console.log('    ✅ Processed bakery warehouses');
  console.log('  ✅ Items and stock created\n');

  // ============================================
  // 4. CREATE SPECIAL ITEMS FOR INVOICES
  // ============================================
  console.log('📦 Step 4: Creating special items for invoices...\n');
  
  // Grocery late item
  let groceryLateItem = await prisma.item.findFirst({
    where: {
      name: 'متاخرات ما قبل السيستيم',
      section: Section.GROCERY,
    },
  });

  if (!groceryLateItem) {
    groceryLateItem = await prisma.item.create({
      data: {
        name: 'متاخرات ما قبل السيستيم',
        section: Section.GROCERY,
        prices: {
          create: [
            { tier: CustomerType.WHOLESALE, price: 1 },
            { tier: CustomerType.RETAIL, price: 1 },
          ],
        },
      },
    });
    console.log('  ✨ Created: متاخرات ما قبل السيستيم (GROCERY)');
  } else {
    console.log('  ✅ Found: متاخرات ما قبل السيستيم (GROCERY)');
  }

  // Bakery late item
  let bakeryLateItem = await prisma.item.findFirst({
    where: {
      name: 'متاخرات ما قبل السيستيم',
      section: Section.BAKERY,
    },
  });

  if (!bakeryLateItem) {
    bakeryLateItem = await prisma.item.create({
      data: {
        name: 'متاخرات ما قبل السيستيم',
        section: Section.BAKERY,
        prices: {
          create: [
            { tier: CustomerType.WHOLESALE, price: 1 },
            { tier: CustomerType.RETAIL, price: 1 },
          ],
        },
      },
    });
    console.log('  ✨ Created: متاخرات ما قبل السيستيم (BAKERY)');
  } else {
    console.log('  ✅ Found: متاخرات ما قبل السيستيم (BAKERY)');
  }
  console.log('  ✅ Special items ready\n');

  // ============================================
  // 5. CREATE SUPPLIERS
  // ============================================
  console.log('🏭 Step 5: Creating suppliers...\n');
  const suppliers: Record<string, any> = {};

  for (const supplierName of suppliersData) {
    let supplier = await prisma.supplier.findFirst({
      where: { name: supplierName },
    });

    if (!supplier) {
      supplier = await prisma.supplier.create({
        data: {
          name: supplierName,
          phone: null,
          address: null,
        },
      });
      console.log(`  ✨ Created supplier: ${supplierName}`);
    } else {
      console.log(`  ✅ Found supplier: ${supplierName}`);
    }
    suppliers[supplierName] = supplier;
  }
  console.log('  ✅ Suppliers ready\n');

  // ============================================
  // 6. CREATE CUSTOMERS AND INVOICES
  // ============================================
  console.log('🛒 Step 6: Creating customers and invoices...\n');

  // Grocery Customers
  console.log('  Processing Grocery Customers...');
  let groceryInvoicesCreated = 0;
  for (const customerInfo of groceryCustomers) {
    let customer = await prisma.customer.findFirst({
      where: { name: customerInfo.name },
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          name: customerInfo.name,
          type: CustomerType.WHOLESALE,
          division: Section.GROCERY,
        },
      });
    } else {
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: {
          type: CustomerType.WHOLESALE,
          division: Section.GROCERY,
        },
      });
    }

    const existingInvoice = await prisma.salesInvoice.findFirst({
      where: {
        customerId: customer.id,
        items: {
          some: {
            itemId: groceryLateItem.id,
          },
        },
      },
    });

    if (!existingInvoice) {
      const amount = new Prisma.Decimal(customerInfo.amount);
      const timestamp = Date.now();
      const customerShortId = customer.id.slice(-6);
      const invoiceNumber = `PRE-SYS-${timestamp}-${customerShortId}`;

      await prisma.salesInvoice.create({
        data: {
          invoiceNumber,
          inventoryId: mainWarehouse.id,
          section: Section.GROCERY,
          salesUserId: users[Role.SALES_GROCERY].id,
          customerId: customer.id,
          paymentMethod: PaymentMethod.CASH,
          paymentStatus: PaymentStatus.CREDIT,
          deliveryStatus: DeliveryStatus.DELIVERED,
          paymentConfirmed: false,
          subtotal: amount,
          discount: new Prisma.Decimal(0),
          total: amount,
          paidAmount: new Prisma.Decimal(0),
          notes: 'متاخرات ما قبل السيستيم - لا يؤثر على المخزون',
          items: {
            create: {
              itemId: groceryLateItem.id,
              quantity: amount,
              unitPrice: new Prisma.Decimal(1),
              lineTotal: amount,
            },
          },
        },
      });
      groceryInvoicesCreated++;
    }
  }
  console.log(`    ✅ Created ${groceryInvoicesCreated} grocery invoices`);

  // Bakery Customers
  console.log('  Processing Bakery Customers...');
  let bakeryInvoicesCreated = 0;
  for (const customerInfo of bakeryCustomers) {
    let customer = await prisma.customer.findFirst({
      where: { name: customerInfo.name },
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          name: customerInfo.name,
          type: CustomerType.WHOLESALE,
          division: Section.BAKERY,
        },
      });
    } else {
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: {
          type: CustomerType.WHOLESALE,
          division: Section.BAKERY,
        },
      });
    }

    const existingInvoice = await prisma.salesInvoice.findFirst({
      where: {
        customerId: customer.id,
        items: {
          some: {
            itemId: bakeryLateItem.id,
          },
        },
      },
    });

    if (!existingInvoice) {
      // Split large amounts (> 99,999,999.99) into multiple invoices to avoid Decimal overflow
      const MAX_SAFE_AMOUNT = 99999999.99;
      const totalAmount = customerInfo.amount;
      const timestamp = Date.now();
      const customerShortId = customer.id.slice(-6);
      
      if (totalAmount > MAX_SAFE_AMOUNT) {
        // Split into multiple invoices
        let remaining = totalAmount;
        let invoiceIndex = 1;
        
        while (remaining > 0) {
          const invoiceAmount = Math.min(remaining, MAX_SAFE_AMOUNT);
          const amount = new Prisma.Decimal(invoiceAmount);
          
          const invoiceNumber = `PRE-SYS-BAKERY-${timestamp}-${customerShortId}-${invoiceIndex}`;
          
          await prisma.salesInvoice.create({
            data: {
              invoiceNumber,
              inventoryId: mainWarehouse.id,
              section: Section.BAKERY,
              salesUserId: users[Role.SALES_BAKERY].id,
              customerId: customer.id,
              paymentMethod: PaymentMethod.CASH,
              paymentStatus: PaymentStatus.CREDIT,
              deliveryStatus: DeliveryStatus.DELIVERED,
              paymentConfirmed: false,
              subtotal: amount,
              discount: new Prisma.Decimal(0),
              total: amount,
              paidAmount: new Prisma.Decimal(0),
              notes: `متاخرات ما قبل السيستيم - لا يؤثر على المخزون (جزء ${invoiceIndex})`,
              items: {
                create: {
                  itemId: bakeryLateItem.id,
                  quantity: amount,
                  unitPrice: new Prisma.Decimal(1),
                  lineTotal: amount,
                },
              },
            },
          });
          bakeryInvoicesCreated++;
          remaining -= invoiceAmount;
          invoiceIndex++;
        }
      } else {
        // Single invoice for amounts within limit
        const amount = new Prisma.Decimal(totalAmount);
        const invoiceNumber = `PRE-SYS-BAKERY-${timestamp}-${customerShortId}`;

        await prisma.salesInvoice.create({
          data: {
            invoiceNumber,
            inventoryId: mainWarehouse.id,
            section: Section.BAKERY,
            salesUserId: users[Role.SALES_BAKERY].id,
            customerId: customer.id,
            paymentMethod: PaymentMethod.CASH,
            paymentStatus: PaymentStatus.CREDIT,
            deliveryStatus: DeliveryStatus.DELIVERED,
            paymentConfirmed: false,
            subtotal: amount,
            discount: new Prisma.Decimal(0),
            total: amount,
            paidAmount: new Prisma.Decimal(0),
            notes: 'متاخرات ما قبل السيستيم - لا يؤثر على المخزون',
            items: {
              create: {
                itemId: bakeryLateItem.id,
                quantity: amount,
                unitPrice: new Prisma.Decimal(1),
                lineTotal: amount,
              },
            },
          },
        });
        bakeryInvoicesCreated++;
      }
    }
  }
  console.log(`    ✅ Created ${bakeryInvoicesCreated} bakery invoices`);

  // Agent Retail Customers
  console.log('  Processing Agent Retail Customers...');
  let agentInvoicesCreated = 0;
  for (const customerInfo of agentRetailCustomers) {
    let customer = await prisma.customer.findFirst({
      where: { name: customerInfo.name },
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          name: customerInfo.name,
          type: CustomerType.RETAIL,
          division: Section.GROCERY,
        },
      });
    } else {
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: {
          type: CustomerType.RETAIL,
          division: Section.GROCERY,
        },
      });
    }

    const existingInvoice = await prisma.salesInvoice.findFirst({
      where: {
        customerId: customer.id,
        items: {
          some: {
            itemId: groceryLateItem.id,
          },
        },
      },
    });

    if (!existingInvoice) {
      // Use agent user if available, otherwise fallback to sales_grocery
      const agentUser = users['AGENT_GROCERY'] || users[Role.SALES_GROCERY];
      if (!agentUser) {
        console.log(`    ⚠️  Skipping invoice for ${customerInfo.name} - No sales user available`);
        continue;
      }

      const amount = new Prisma.Decimal(customerInfo.amount);
      const timestamp = Date.now();
      const customerShortId = customer.id.slice(-6);
      const invoiceNumber = `PRE-SYS-AGENT-${timestamp}-${customerShortId}`;

      await prisma.salesInvoice.create({
        data: {
          invoiceNumber,
          inventoryId: mainWarehouse.id,
          section: Section.GROCERY,
          salesUserId: agentUser.id,
          customerId: customer.id,
          paymentMethod: PaymentMethod.CASH,
          paymentStatus: PaymentStatus.CREDIT,
          deliveryStatus: DeliveryStatus.DELIVERED,
          paymentConfirmed: false,
          subtotal: amount,
          discount: new Prisma.Decimal(0),
          total: amount,
          paidAmount: new Prisma.Decimal(0),
          notes: 'متاخرات ما قبل السيستيم - لا يؤثر على المخزون',
          items: {
            create: {
              itemId: groceryLateItem.id,
              quantity: amount,
              unitPrice: new Prisma.Decimal(1),
              lineTotal: amount,
            },
          },
        },
      });
      agentInvoicesCreated++;
    }
  }
  console.log(`    ✅ Created ${agentInvoicesCreated} agent retail invoices`);
  console.log('  ✅ Customers and invoices created\n');

  // ============================================
  // 7. CREATE PROCUREMENT ORDERS
  // ============================================
  console.log('🛒 Step 7: Creating procurement orders...\n');

  // Grocery Procurement Orders
  console.log('  Processing Grocery Procurement Orders...');
  let groceryOrdersCreated = 0;
  for (const orderInfo of groceryProcOrders) {
    const supplier = suppliers[orderInfo.supplier];
    if (!supplier) continue;

    // Use the same item as sales invoices (groceryLateItem)
    const item = groceryLateItem;

    const existingOrder = await prisma.procOrder.findFirst({
      where: {
        supplierId: supplier.id,
        total: orderInfo.amount,
        createdAt: {
          gte: new Date(new Date(orderInfo.date).setHours(0, 0, 0, 0)),
          lte: new Date(new Date(orderInfo.date).setHours(23, 59, 59, 999)),
        },
      },
    });

    if (!existingOrder) {
      const orderDate = new Date(orderInfo.date);
      orderDate.setHours(12, 0, 0, 0);
      const unitCost = orderInfo.quantity > 0 && orderInfo.quantity !== orderInfo.amount
        ? orderInfo.amount / orderInfo.quantity
        : 1;
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const orderNumber = `PRE-SYS-PO-${orderInfo.date.replace(/-/g, '')}-${randomSuffix}`;

      await prisma.procOrder.create({
        data: {
          orderNumber,
          inventoryId: mainWarehouse.id,
          section: Section.GROCERY,
          createdBy: users[Role.PROCUREMENT].id,
          supplierId: supplier.id,
          status: ProcOrderStatus.RECEIVED,
          total: new Prisma.Decimal(orderInfo.amount),
          paidAmount: new Prisma.Decimal(0),
          paymentConfirmed: false,
          notes: `طلب شراء من ${orderInfo.supplier} بتاريخ ${orderInfo.date} - لا يؤثر على المخزون`,
          createdAt: orderDate,
          items: {
            create: {
              itemId: item.id,
              quantity: new Prisma.Decimal(orderInfo.quantity),
              unitCost: new Prisma.Decimal(unitCost),
              lineTotal: new Prisma.Decimal(orderInfo.amount),
            },
          },
        },
      });
      groceryOrdersCreated++;
    }
  }
  console.log(`    ✅ Created ${groceryOrdersCreated} grocery orders`);

  // Bakery Procurement Orders
  console.log('  Processing Bakery Procurement Orders...');
  let bakeryOrdersCreated = 0;
  for (const orderInfo of bakeryProcOrders) {
    const supplier = suppliers[orderInfo.supplier];
    if (!supplier) continue;

    // Use the same item as sales invoices (bakeryLateItem)
    const item = bakeryLateItem;

    const existingOrder = await prisma.procOrder.findFirst({
      where: {
        supplierId: supplier.id,
        total: orderInfo.amount,
        createdAt: {
          gte: new Date(new Date(orderInfo.date).setHours(0, 0, 0, 0)),
          lte: new Date(new Date(orderInfo.date).setHours(23, 59, 59, 999)),
        },
      },
    });

    if (!existingOrder) {
      const orderDate = new Date(orderInfo.date);
      orderDate.setHours(12, 0, 0, 0);
      const unitCost = orderInfo.quantity > 0 && orderInfo.quantity !== orderInfo.amount
        ? orderInfo.amount / orderInfo.quantity
        : 1;
      
      // Split large amounts (> 99,999,999.99) into multiple orders to avoid Decimal overflow
      const MAX_SAFE_AMOUNT = 99999999.99;
      const totalAmount = orderInfo.amount;
      const totalQuantity = orderInfo.quantity;
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const baseOrderNumber = `PRE-SYS-BAKERY-PO-${orderInfo.date.replace(/-/g, '')}-${randomSuffix}`;
      
      if (totalAmount > MAX_SAFE_AMOUNT) {
        // Split into multiple orders
        let remainingAmount = totalAmount;
        let remainingQuantity = totalQuantity;
        let orderIndex = 1;
        
        while (remainingAmount > 0) {
          const orderAmount = Math.min(remainingAmount, MAX_SAFE_AMOUNT);
          // Calculate proportional quantity
          const orderQuantity = totalQuantity > 0
            ? (orderAmount / totalAmount) * totalQuantity
            : orderAmount; // If quantity equals amount, use amount directly
          
          const orderNumber = `${baseOrderNumber}-${orderIndex}`;
          
          // Recalculate unit cost for this split order
          const splitUnitCost = orderQuantity > 0
            ? orderAmount / orderQuantity
            : unitCost;
          
          await prisma.procOrder.create({
            data: {
              orderNumber,
              inventoryId: mainWarehouse.id,
              section: Section.BAKERY,
              createdBy: users[Role.PROCUREMENT].id,
              supplierId: supplier.id,
              status: ProcOrderStatus.RECEIVED,
              total: new Prisma.Decimal(orderAmount),
              paidAmount: new Prisma.Decimal(0),
              paymentConfirmed: false,
              notes: `طلب شراء من ${orderInfo.supplier} بتاريخ ${orderInfo.date} - لا يؤثر على المخزون (جزء ${orderIndex})`,
              createdAt: orderDate,
              items: {
                create: {
                  itemId: item.id,
                  quantity: new Prisma.Decimal(orderQuantity),
                  unitCost: new Prisma.Decimal(splitUnitCost),
                  lineTotal: new Prisma.Decimal(orderAmount),
                },
              },
            },
          });
          bakeryOrdersCreated++;
          remainingAmount -= orderAmount;
          remainingQuantity -= orderQuantity;
          orderIndex++;
        }
      } else {
        // Single order for amounts within limit
        await prisma.procOrder.create({
          data: {
            orderNumber: baseOrderNumber,
            inventoryId: mainWarehouse.id,
            section: Section.BAKERY,
            createdBy: users[Role.PROCUREMENT].id,
            supplierId: supplier.id,
            status: ProcOrderStatus.RECEIVED,
            total: new Prisma.Decimal(totalAmount),
            paidAmount: new Prisma.Decimal(0),
            paymentConfirmed: false,
            notes: `طلب شراء من ${orderInfo.supplier} بتاريخ ${orderInfo.date} - لا يؤثر على المخزون`,
            createdAt: orderDate,
            items: {
              create: {
                itemId: item.id,
                quantity: new Prisma.Decimal(totalQuantity),
                unitCost: new Prisma.Decimal(unitCost),
                lineTotal: new Prisma.Decimal(totalAmount),
              },
            },
          },
        });
        bakeryOrdersCreated++;
      }
    }
  }
  console.log(`    ✅ Created ${bakeryOrdersCreated} bakery orders`);
  console.log('  ✅ Procurement orders created\n');

  // ============================================
  // 8. CREATE INBOUND DEBTS
  // ============================================
  console.log('💰 Step 8: Creating inbound debts...\n');
  let debtsCreated = 0;
  let debtsSkipped = 0;
  const MAX_SAFE_AMOUNT = 99999999.99;
  
  for (const debtInfo of inboundDebtsData) {
    try {
      // Split large amounts (> 99,999,999.99) into multiple income records to avoid Decimal overflow
      const totalAmount = debtInfo.amount;
      
      if (totalAmount > MAX_SAFE_AMOUNT) {
        // Split into multiple income records
        let remainingAmount = totalAmount;
        let recordIndex = 1;
        
        while (remainingAmount > 0) {
          const recordAmount = Math.min(remainingAmount, MAX_SAFE_AMOUNT);
          const description = recordIndex > 1 
            ? `${debtInfo.description} (جزء ${recordIndex})`
            : debtInfo.description;
          
          // Check if this split record already exists
          const existingDebt = await prisma.income.findFirst({
            where: {
              description: description,
              amount: new Prisma.Decimal(recordAmount),
              isDebt: true,
            },
          });

          if (existingDebt) {
            console.log(`  ⏭️  Debt part ${recordIndex} already exists: ${description}`);
            remainingAmount -= recordAmount;
            recordIndex++;
            continue;
          }

          await prisma.income.create({
            data: {
              amount: new Prisma.Decimal(recordAmount),
              method: PaymentMethod.CASH,
              description: description,
              isDebt: true,
              createdBy: users[Role.ACCOUNTANT].id,
            },
          });
          debtsCreated++;
          console.log(`  ✨ Created debt part ${recordIndex}: ${description} - ${recordAmount.toLocaleString()} SDG`);
          remainingAmount -= recordAmount;
          recordIndex++;
        }
      } else {
        // Single income record for amounts within limit
        // Check if debt already exists (by description, amount, and isDebt)
        const existingDebt = await prisma.income.findFirst({
          where: {
            description: debtInfo.description,
            amount: new Prisma.Decimal(totalAmount),
            isDebt: true,
          },
        });

        if (existingDebt) {
          console.log(`  ⏭️  Debt already exists: ${debtInfo.description}`);
          debtsSkipped++;
          continue;
        }

        await prisma.income.create({
          data: {
            amount: new Prisma.Decimal(totalAmount),
            method: PaymentMethod.CASH,
            description: debtInfo.description,
            isDebt: true,
            createdBy: users[Role.ACCOUNTANT].id,
          },
        });
        debtsCreated++;
        console.log(`  ✨ Created debt: ${debtInfo.description}`);
      }
    } catch (error: any) {
      console.error(`  ❌ Error creating debt "${debtInfo.description}":`, error.message);
      debtsSkipped++;
    }
  }
  console.log(`  ✅ Created ${debtsCreated} inbound debts`);
  if (debtsSkipped > 0) {
    console.log(`  ⏭️  Skipped ${debtsSkipped} debts (already exist or errors)\n`);
  } else {
    console.log();
  }

  // ============================================
  // 9. CREATE OPENING BALANCES
  // ============================================
  console.log('💰 Step 9: Creating opening balances...\n');
  
  // Check if opening balances already exist
  const existingCashBalance = await prisma.openingBalance.findFirst({
    where: {
      scope: BalanceScope.CASHBOX,
      paymentMethod: PaymentMethod.CASH,
      isClosed: false,
    },
  });

  const existingBankBalance = await prisma.openingBalance.findFirst({
    where: {
      scope: BalanceScope.CASHBOX,
      paymentMethod: PaymentMethod.BANK,
      isClosed: false,
    },
  });

  if (!existingCashBalance) {
    await prisma.openingBalance.create({
      data: {
        scope: BalanceScope.CASHBOX,
        amount: new Prisma.Decimal(11853400),
        paymentMethod: PaymentMethod.CASH,
        isClosed: false,
        notes: 'رصيد افتتاحي نقدي',
      },
    });
    console.log('  ✨ Created CASH opening balance: 11,853,400 SDG');
  } else {
    // Update existing balance
    await prisma.openingBalance.update({
      where: { id: existingCashBalance.id },
      data: {
        amount: new Prisma.Decimal(11853400),
      },
    });
    console.log('  ✅ Updated CASH opening balance: 11,853,400 SDG');
  }

  if (!existingBankBalance) {
    await prisma.openingBalance.create({
      data: {
        scope: BalanceScope.CASHBOX,
        amount: new Prisma.Decimal(1942736),
        paymentMethod: PaymentMethod.BANK,
        isClosed: false,
        notes: 'رصيد افتتاحي بنك',
      },
    });
    console.log('  ✨ Created BANK opening balance: 1,942,736 SDG');
  } else {
    // Update existing balance
    await prisma.openingBalance.update({
      where: { id: existingBankBalance.id },
      data: {
        amount: new Prisma.Decimal(1942736),
      },
    });
    console.log('  ✅ Updated BANK opening balance: 1,942,736 SDG');
  }
  console.log('  ✅ Opening balances ready\n');

  // ============================================
  // SUMMARY
  // ============================================
  console.log('='.repeat(60));
  console.log('✅ Comprehensive seed completed successfully!');
  console.log('='.repeat(60));
  console.log('\n📊 Summary:');
  console.log(`   Users: ${usersData.length} users created/updated (password: password123)`);
  console.log(`   Warehouses: ${Object.keys(warehouses).length} warehouses`);
  console.log(`   Grocery Customers: ${groceryCustomers.length} customers, ${groceryInvoicesCreated} invoices`);
  console.log(`   Bakery Customers: ${bakeryCustomers.length} customers, ${bakeryInvoicesCreated} invoices`);
  console.log(`   Agent Retail Customers: ${agentRetailCustomers.length} customers, ${agentInvoicesCreated} invoices`);
  console.log(`   Suppliers: ${suppliersData.length} suppliers`);
  console.log(`   Grocery Procurement Orders: ${groceryOrdersCreated} orders`);
  console.log(`   Bakery Procurement Orders: ${bakeryOrdersCreated} orders`);
  console.log(`   Inbound Debts: ${debtsCreated} debts`);
  console.log('\n🔑 Login Credentials:');
  console.log('   All users have password: password123');
  for (const userData of usersData) {
    console.log(`   - ${userData.username} (${userData.role})`);
  }
  console.log('\n');
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

