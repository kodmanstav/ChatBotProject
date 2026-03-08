# server

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.





# Microservices

## סקירת ה־Microservices

### userInterface.ts  
נקודת הכניסה והיציאה של המשתמש למערכת.  
**Kafka Topics:**  
- **פולט:** `user-input-events`, `user-control-events`  
- **צורך:** `bot-responses`

---

### memoryService.ts  
אחראי על ניהול ושמירת היסטוריית השיחה בקובץ.  
**Kafka Topics:**  
- **צורך:** `user-input-events`, `app-results`, `user-control-events`, `conversation-history-request`  
- **פולט:** `conversation-history-update`, `conversation-history-response`

---

### routerService.ts  
מבצע זיהוי כוונות ומנתב את הבקשות לשירות המתאים.  
**Kafka Topics:**  
- **צורך:** `user-input-events`, `conversation-history-update`  
- **פולט:** `intent-math`, `intent-weather`, `intent-exchange`, `intent-general-chat`, `conversation-history-request`

---

### mathApp.ts  
מבצע חישובים מתמטיים.  
**Kafka Topics:**  
- **צורך:** `intent-math`  
- **פולט:** `app-results`

---

### weatherApp.ts  
שולף נתוני מזג אוויר ממקור חיצוני.  
**Kafka Topics:**  
- **צורך:** `intent-weather`  
- **פולט:** `app-results`

---

### exchangeApp.ts  
מבצע המרת מטבעות באמצעות מיפוי שערים סטטי.  
**Kafka Topics:**  
- **צורך:** `intent-exchange`  
- **פולט:** `app-results`

---

### generalChatApp.ts  
שירות שיחה כללי המשתמש ב־LLM תוך הזרקת הקשר משיחת העבר.  
**Kafka Topics:**  
- **צורך:** `intent-general-chat`  
- **פולט:** `app-results`

---

### responseAggregator.ts  
מאחד את תוצאות כל שירותי ה־Worker לתשובה סופית אחת למשתמש.  
**Kafka Topics:**  
- **צורך:** `app-results`  
- **פולט:** `bot-responses`

---
