-- Visualizaciones: veces que se mostró el post (el alcance cuenta personas únicas).
ALTER TABLE publicaciones_ig ADD COLUMN visualizaciones INTEGER;
UPDATE publicaciones_ig SET metricas_actualizadas = NULL;
