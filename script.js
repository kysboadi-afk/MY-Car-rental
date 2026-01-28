let selectedCar = null;
let daily = 0, weekly = 0, deposit = 0, totalCost = 0;
const pickup = document.getElementById('pickup');
const returnDate = document.getElementById('return');
const pickupTimeInput = document.getElementById('pickupTime');
const returnTimeInput = document.getElementById('returnTime');
const agree = document.getElementById('agree');
const stripePayBtn = document.getElementById('stripePay');
const totalPriceDisplay = document.getElementById('total');
const bookedDates = { "Camry 2012": [], "Slingshot R": [] };

/* ---------- SLIDER ---------- */
const sliders = { slingshot:{index:0,slides:[]}, camry:{index:0,slides:[]} };
function initSliders(){
  sliders.slingshot.slides=document.querySelectorAll('.car-slider:nth-child(1) .slide');
  sliders.camry.slides=document.querySelectorAll('.car-slider:nth-child(2) .slide');
}
function showSlide(car){const s=sliders[car];s.slides.forEach((img,i)=>img.classList.toggle('active',i===s.index)); updateDots(car);}
function nextSlide(car){const s=sliders[car]; s.index=(s.index+1)%s.slides.length; showSlide(car);}
function prevSlide(car){const s=sliders[car]; s.index=(s.index-1+s.slides.length)%s.slides.length; showSlide(car);}
function updateDots(car){const s=sliders[car]; const dots=document.querySelectorAll(`#dots-${car} .dot`); dots.forEach((dot,i)=>dot.classList.toggle('active',i===s.index));}
function goToSlide(car,index){sliders[car].index=index; showSlide(car);}
window.onload=initSliders;

/* ---------- CAR SELECTION ---------- */
function selectCar(name,d,w,dep,el){
  selectedCar=name; daily=d; weekly=w; deposit=dep;
  document.querySelectorAll('.car-slider').forEach(card=>card.classList.remove('selected'));
  el.closest('.car-slider').classList.add('selected');
  displayBookedDates(name);
  disableBookedDates();
  alert(name+" selected! Now choose dates and enter your info below.");
  calculateTotal();
  checkAvailability();
  updateStripeButton();
}

/* ---------- DISPLAY BOOKED DATES ---------- */
function displayBookedDates(car){
  const container=document.getElementById('bookedDatesContainer'); container.innerHTML='';
  const dates=bookedDates[car]||[];
  if(dates.length){
    container.innerHTML='<strong>Booked Dates:</strong> ';
    dates.forEach(date=>{ const span=document.createElement('span'); span.className='booked-date'; span.innerText=date; container.appendChild(span); });
  }
}

/* ---------- RETURN TIME SYNC ---------- */
function syncReturnTime(){ returnTimeInput.value = pickupTimeInput.value; }

/* ---------- TOTAL PRICE ---------- */
function calculateTotal(){
  const pick=new Date(pickup.value),ret=new Date(returnDate.value);
  if(!selectedCar || !pick || !ret || ret<=pick) return;
  const days=Math.ceil((ret-pick)/(1000*60*60*24));
  let cost=(weekly>0 && days>=7)?Math.floor(days/7)*weekly+(days%7)*daily:days*daily;
  cost+=deposit;
  totalCost=cost;
  totalPriceDisplay.innerText=totalCost;
}

/* ---------- CHECK AVAILABILITY ---------- */
function checkAvailability(){
  if(!selectedCar || !pickup.value || !returnDate.value) return document.getElementById('availability').innerText='';
  const dates=bookedDates[selectedCar]||[];
  const conflict=dates.some(date=>date>=pickup.value && date<=returnDate.value);
  const status=document.getElementById('availability');
  if(conflict){ status.innerText='❌ Not available'; status.style.color='red'; }
  else{ status.innerText='✅ Available'; status.style.color='green'; }
}

/* ---------- RESERVE ---------- */
function reserve(){
  const email=document.getElementById('email').value;
  if(!selectedCar){alert('Please select a vehicle'); return;}
  if(!email){alert('Please enter your email'); return;}
  if(!agree.checked){alert('You must agree to the Rental Agreement & Terms'); return;}
  if(!pickup.value || !returnDate.value){alert('Please select valid dates'); return;}
  alert('✅ Reservation request sent! We will contact you shortly.');
  const datesToBlock=getDatesBetween(pickup.value,returnDate.value);
  bookedDates[selectedCar]=bookedDates[selectedCar].concat(datesToBlock);
  displayBookedDates(selectedCar);
  checkAvailability();
}

/* ---------- GET DATES BETWEEN ---------- */
function getDatesBetween(start,end){
  let arr=[],current=new Date(start),last=new Date(end);
  while(current<=last){ arr.push(current.toISOString().split('T')[0]); current.setDate(current.getDate()+1); }
  return arr;
}

/* ---------- DISABLE BOOKED DATES ---------- */
function disableBookedDates(){
  if(!selectedCar) return;
  const booked=bookedDates[selectedCar]||[];
  const today=new Date().toISOString().split('T')[0];
  [pickup,returnDate].forEach(input=>{
    input.setAttribute('min',today);
    input.addEventListener('input',function(){
      if(booked.includes(this.value)){ alert('❌ This date is already booked!'); this.value=''; }
      calculateTotal(); checkAvailability(); updateStripeButton();
    });
  });
}

/* ---------- STRIPE BUTTON ---------- */
function updateStripeButton(){
  stripePayBtn.disabled = !selectedCar || !pickup.value || !returnDate.value || !agree.checked || document.getElementById('availability').innerText.includes('❌');
}

stripePayBtn.addEventListener("click", async () => {
  if(!selectedCar || totalCost<=0){ alert("Please complete your booking first."); return; }
  const email=document.getElementById("email").value;
  const pickupDate=pickup.value;
  const returnDateValue=returnDate.value;
  if(!email || !pickupDate || !returnDateValue){ alert("Please fill in all booking details."); return; }

  try{
    const res=await fetch("https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session",
      { method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ car:selectedCar, amount:totalCost, email:email, pickup:pickupDate, returnDate:returnDateValue })
      });
    const data=await res.json();
    if(data.url) window.location.href=data.url;
    else alert("Stripe session failed to create.");
  }catch(err){ console.error(err); alert("Payment error. Please try again."); }
});

/* ---------- UPDATE STRIPE BUTTON ON CHANGE ---------- */
[pickup, returnDate, agree].forEach(el=>el.addEventListener('change',updateStripeButton));
pickupTimeInput.addEventListener('change',syncReturnTime);
