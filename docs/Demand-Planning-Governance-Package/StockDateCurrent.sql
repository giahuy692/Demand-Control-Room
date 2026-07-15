USE [3PPOS]
GO
/****** Object:  StoredProcedure [dbo].[sp_StockDateCurrent]    Script Date: 7/13/2026 3:56:10 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO


ALTER PROCEDURE [dbo].[sp_StockDateCurrent]
	@User nvarchar(50),
	@DocumentNo int
AS
BEGIN
IF(@DocumentNo>0)
BEGIN
	
	UPDATE tbl_LSProductPeriodStock
	SET Stock=A.Stock,
		RealStock=A.RealStock,
		AvgPrice=a.AvgPrice
	FROM (SELECT A.Code, B.* FROM tbl_LSProductPeriodStock A inner join
		(SELECT Product, ExpiredDate, SUM(Stock) Stock, SUM(RealStock) RealStock, AvgPrice, CreateBy, CreateTime FROM
			(SELECT tbl_OPSImExDetails.Product, tbl_OPSImExDetails.ExpiredDate,  
				CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
				END Stock,  
				CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
				END RealStock,
				ISNULL(tbl_LSProduct.AvgPrice,0) AvgPrice, @User CreateBy, GETDATE() CreateTime
			FROM tbl_OPSImExDetails INNER JOIN tbl_OPSImExMaster 
				ON tbl_OPSImExDetails.DocumentNo = tbl_OPSImExMaster.Code INNER JOIN
				tbl_LSProduct ON tbl_OPSImExDetails.Product = tbl_LSProduct.Code
			WHERE  tbl_OPSImExDetails.ExpiredDate IS NOT NULL and
				tbl_OPSImExDetails.Product in (SELECT Product FROM tbl_OPSImExDetails
				WHERE DocumentNo=@DocumentNo)

			UNION

			SELECT tbl_WWSSODetails.Product, tbl_OPSIOPOExpired.ExpiredDate,
				CASE  
					WHEN tbl_OPSIOPO.[Status] IN (41, 42, 43, 44) 
						THEN - tbl_OPSIOPOExpired.Quantity 
					ELSE 0
					END Stock,
				0 RealStock,
				ISNULL(tbl_LSProduct.AvgPrice, 0) AS AvgPrice, @User AS CreateBy, GETDATE() AS CreateTime
			FROM tbl_LSProduct 
				INNER JOIN tbl_WWSSODetails 
					ON tbl_LSProduct.Code = tbl_WWSSODetails.Product
				INNER JOIN tbl_OPSIOPODetails 
					ON tbl_WWSSODetails.Code = tbl_OPSIOPODetails.WWSSODetails 
				INNER JOIN tbl_OPSIOPOExpired 
					ON tbl_OPSIOPODetails.Code = tbl_OPSIOPOExpired.OPSIOPODetails 
				INNER JOIN tbl_OPSIOPO 
					ON tbl_OPSIOPODetails.OPSIOPO = tbl_OPSIOPO.Code
			WHERE tbl_WWSSODetails.Product in (SELECT Product FROM tbl_OPSImExDetails
				WHERE DocumentNo=@DocumentNo)) A
			GROUP BY Product, ExpiredDate, AvgPrice,CreateBy, CreateTime
			) B ON A.Product=B.Product AND A.ExpiredDate=B.ExpiredDate) A
		WHERE tbl_LSProductPeriodStock.Code=A.Code
	
	INSERT INTO tbl_LSProductPeriodStock
	(Product, ExpiredDate, Stock, RealStock, AvgPrice,
	CreateBy, CreateTime)
	
	SELECT B.* FROM 
		(SELECT Product, ExpiredDate, SUM(Stock) Stock, SUM(RealStock) RealStock, AvgPrice, CreateBy, CreateTime FROM
			(SELECT tbl_OPSImExDetails.Product, tbl_OPSImExDetails.ExpiredDate,  
				CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
				END Stock,				 
				CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
				END RealStock,
				ISNULL(tbl_LSProduct.AvgPrice,0) AvgPrice, @User CreateBy, GETDATE() CreateTime
			FROM tbl_OPSImExDetails INNER JOIN tbl_OPSImExMaster 
				ON tbl_OPSImExDetails.DocumentNo = tbl_OPSImExMaster.Code INNER JOIN
				tbl_LSProduct ON tbl_OPSImExDetails.Product = tbl_LSProduct.Code
			WHERE  tbl_OPSImExDetails.ExpiredDate IS NOT NULL and
				tbl_OPSImExDetails.Product in (SELECT Product FROM tbl_OPSImExDetails
				WHERE DocumentNo=@DocumentNo)  

			UNION

			SELECT tbl_WWSSODetails.Product, tbl_OPSIOPOExpired.ExpiredDate,
				CASE  
					WHEN tbl_OPSIOPO.[Status] IN (41, 42, 43, 44) 
						THEN - tbl_OPSIOPOExpired.Quantity 
					ELSE 0
					END Stock, 
				 0 RealStock,
				ISNULL(tbl_LSProduct.AvgPrice, 0) AS AvgPrice, @User AS CreateBy, GETDATE() AS CreateTime
			FROM tbl_LSProduct 
				INNER JOIN tbl_WWSSODetails 
					ON tbl_LSProduct.Code = tbl_WWSSODetails.Product
				INNER JOIN tbl_OPSIOPODetails 
					ON tbl_WWSSODetails.Code = tbl_OPSIOPODetails.WWSSODetails 
				INNER JOIN tbl_OPSIOPOExpired 
					ON tbl_OPSIOPODetails.Code = tbl_OPSIOPOExpired.OPSIOPODetails 
				INNER JOIN tbl_OPSIOPO 
					ON tbl_OPSIOPODetails.OPSIOPO = tbl_OPSIOPO.Code
					WHERE tbl_WWSSODetails.Product in (SELECT Product FROM tbl_OPSImExDetails
				WHERE DocumentNo=@DocumentNo)) A
			GROUP BY Product, ExpiredDate, AvgPrice,CreateBy, CreateTime
			HAVING SUM(Stock)<>0
			) B LEFT JOIN tbl_LSProductPeriodStock A ON A.Product=B.Product AND A.ExpiredDate=B.ExpiredDate
		WHERE A.Code IS NULL	
	
	UPDATE tbl_LSProduct
	SET Quantity=A.RealStock
	FROM (SELECT Product, SUM(Stock) Stock, SUM(RealStock) RealStock FROM
	(SELECT tbl_OPSImExDetails.Product, tbl_OPSImExDetails.ExpiredDate,  
			CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
			END Stock, 
				CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
				END RealStock,			
			ISNULL(tbl_LSProduct.AvgPrice,0) AvgPrice, @User CreateBy, GETDATE() CreateTime
		FROM tbl_OPSImExDetails INNER JOIN tbl_OPSImExMaster 
				ON tbl_OPSImExDetails.DocumentNo = tbl_OPSImExMaster.Code INNER JOIN
				tbl_LSProduct ON tbl_OPSImExDetails.Product = tbl_LSProduct.Code
		WHERE  tbl_OPSImExDetails.ExpiredDate IS NOT NULL and
		tbl_OPSImExDetails.Product in (SELECT Product FROM tbl_OPSImExDetails
		WHERE DocumentNo=@DocumentNo)  

		UNION

		SELECT tbl_WWSSODetails.Product, tbl_OPSIOPOExpired.ExpiredDate,
			CASE  
				WHEN tbl_OPSIOPO.[Status] IN (41, 42, 43, 44) 
						THEN - tbl_OPSIOPOExpired.Quantity 
					ELSE 0
				END Stock,  
				0 RealStock,
			ISNULL(tbl_LSProduct.AvgPrice, 0) AS AvgPrice, @User AS CreateBy, GETDATE() AS CreateTime
		FROM tbl_LSProduct 
			INNER JOIN tbl_WWSSODetails 
				ON tbl_LSProduct.Code = tbl_WWSSODetails.Product
			INNER JOIN tbl_OPSIOPODetails 
				ON tbl_WWSSODetails.Code = tbl_OPSIOPODetails.WWSSODetails 
			INNER JOIN tbl_OPSIOPOExpired 
				ON tbl_OPSIOPODetails.Code = tbl_OPSIOPOExpired.OPSIOPODetails 
			INNER JOIN tbl_OPSIOPO 
				ON tbl_OPSIOPODetails.OPSIOPO = tbl_OPSIOPO.Code      
		WHERE tbl_WWSSODetails.Product in (SELECT Product FROM tbl_OPSImExDetails
		WHERE DocumentNo=@DocumentNo)) A
	GROUP BY Product
	HAVING SUM(Stock)<>0) A
	WHERE tbl_LSProduct.Code=A.Product
	
END
ELSE
BEGIN
	UPDATE tbl_LSProductPeriodStock
	SET Stock=A.Stock,
	RealStock=A.RealStock,
		AvgPrice=a.AvgPrice
	FROM (SELECT A.Code, B.* FROM tbl_LSProductPeriodStock A inner join
		(SELECT Product, ExpiredDate, SUM(Stock) Stock, SUM(RealStock) RealStock, AvgPrice, CreateBy, CreateTime FROM
			(SELECT tbl_OPSImExDetails.Product, tbl_OPSImExDetails.ExpiredDate,  
				CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
				END Stock,  
				CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
				END RealStock,
				ISNULL(tbl_LSProduct.AvgPrice,0) AvgPrice, @User CreateBy, GETDATE() CreateTime
			FROM tbl_OPSImExDetails INNER JOIN tbl_OPSImExMaster 
				ON tbl_OPSImExDetails.DocumentNo = tbl_OPSImExMaster.Code INNER JOIN
				tbl_LSProduct ON tbl_OPSImExDetails.Product = tbl_LSProduct.Code
			WHERE  tbl_OPSImExDetails.ExpiredDate IS NOT NULL

			UNION

			SELECT tbl_WWSSODetails.Product, tbl_OPSIOPOExpired.ExpiredDate,
				CASE  
					WHEN tbl_OPSIOPO.[Status] IN (41, 42, 43, 44) 
						THEN - tbl_OPSIOPOExpired.Quantity 
					ELSE 0
					END Stock,  
				0 RealStock,
				ISNULL(tbl_LSProduct.AvgPrice, 0) AS AvgPrice, @User AS CreateBy, GETDATE() AS CreateTime
			FROM tbl_LSProduct 
				INNER JOIN tbl_WWSSODetails 
					ON tbl_LSProduct.Code = tbl_WWSSODetails.Product
				INNER JOIN tbl_OPSIOPODetails 
					ON tbl_WWSSODetails.Code = tbl_OPSIOPODetails.WWSSODetails 
				INNER JOIN tbl_OPSIOPOExpired 
					ON tbl_OPSIOPODetails.Code = tbl_OPSIOPOExpired.OPSIOPODetails 
				INNER JOIN tbl_OPSIOPO 
					ON tbl_OPSIOPODetails.OPSIOPO = tbl_OPSIOPO.Code) A
			GROUP BY Product, ExpiredDate, AvgPrice,CreateBy, CreateTime
			) B ON A.Product=B.Product AND A.ExpiredDate=B.ExpiredDate) A
		WHERE tbl_LSProductPeriodStock.Code=A.Code
	
	INSERT INTO tbl_LSProductPeriodStock
	(Product, ExpiredDate, Stock, RealStock, AvgPrice,
	CreateBy, CreateTime)
	
	SELECT B.* FROM 
		(SELECT Product, ExpiredDate, SUM(Stock) Stock, SUM(RealStock) RealStock, AvgPrice, CreateBy, CreateTime FROM
			(SELECT tbl_OPSImExDetails.Product, tbl_OPSImExDetails.ExpiredDate,  
				CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
				END Stock, 
				CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
				END RealStock,
				ISNULL(tbl_LSProduct.AvgPrice,0) AvgPrice, @User CreateBy, GETDATE() CreateTime
			FROM tbl_OPSImExDetails INNER JOIN tbl_OPSImExMaster 
				ON tbl_OPSImExDetails.DocumentNo = tbl_OPSImExMaster.Code INNER JOIN
				tbl_LSProduct ON tbl_OPSImExDetails.Product = tbl_LSProduct.Code
			WHERE  tbl_OPSImExDetails.ExpiredDate IS NOT NULL

			UNION

			SELECT tbl_WWSSODetails.Product, tbl_OPSIOPOExpired.ExpiredDate,
				CASE  
					WHEN tbl_OPSIOPO.[Status] IN (41, 42, 43, 44) 
						THEN - tbl_OPSIOPOExpired.Quantity 
					ELSE 0
					END Stock,  
				0 RealStock,
				ISNULL(tbl_LSProduct.AvgPrice, 0) AS AvgPrice, @User AS CreateBy, GETDATE() AS CreateTime
			FROM tbl_LSProduct 
				INNER JOIN tbl_WWSSODetails 
					ON tbl_LSProduct.Code = tbl_WWSSODetails.Product
				INNER JOIN tbl_OPSIOPODetails 
					ON tbl_WWSSODetails.Code = tbl_OPSIOPODetails.WWSSODetails 
				INNER JOIN tbl_OPSIOPOExpired 
					ON tbl_OPSIOPODetails.Code = tbl_OPSIOPOExpired.OPSIOPODetails 
				INNER JOIN tbl_OPSIOPO 
					ON tbl_OPSIOPODetails.OPSIOPO = tbl_OPSIOPO.Code) A
			GROUP BY Product, ExpiredDate, AvgPrice,CreateBy, CreateTime
			) B LEFT JOIN tbl_LSProductPeriodStock A ON A.Product=B.Product AND A.ExpiredDate=B.ExpiredDate
		WHERE A.Code IS NULL
	--CAP NHẬT SỐ LƯỢNG HÀNG TỔNG
	UPDATE tbl_LSProduct
	SET Quantity=A.RealStock
	FROM (SELECT Product, SUM(Stock) Stock, SUM(RealStock) RealStock FROM
	(
		SELECT tbl_OPSImExDetails.Product, tbl_OPSImExDetails.ExpiredDate,  
			CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
			END Stock,  
				CASE tbl_OPSImExMaster.DocumentStatus
					WHEN 3 THEN  ISNULL(tbl_OPSImExDetails.QtyReceived,0)
					WHEN 6 THEN  - ISNULL(tbl_OPSImExDetails.QtyReceived,0)
				END RealStock,
			ISNULL(tbl_LSProduct.AvgPrice,0) AvgPrice, @User CreateBy, GETDATE() CreateTime
		FROM tbl_OPSImExDetails INNER JOIN tbl_OPSImExMaster 
				ON tbl_OPSImExDetails.DocumentNo = tbl_OPSImExMaster.Code INNER JOIN
				tbl_LSProduct ON tbl_OPSImExDetails.Product = tbl_LSProduct.Code
		WHERE  tbl_OPSImExDetails.ExpiredDate IS NOT NULL

		UNION

		SELECT tbl_WWSSODetails.Product, tbl_OPSIOPOExpired.ExpiredDate,
			CASE  
				WHEN tbl_OPSIOPO.[Status] IN (41, 42, 43, 44) 
					THEN - tbl_OPSIOPOExpired.Quantity 
				ELSE 0
				END Stock,  
				0 RealStock,
			ISNULL(tbl_LSProduct.AvgPrice, 0) AS AvgPrice, @User AS CreateBy, GETDATE() AS CreateTime
		FROM tbl_LSProduct 
			INNER JOIN tbl_WWSSODetails 
				ON tbl_LSProduct.Code = tbl_WWSSODetails.Product
			INNER JOIN tbl_OPSIOPODetails 
				ON tbl_WWSSODetails.Code = tbl_OPSIOPODetails.WWSSODetails 
			INNER JOIN tbl_OPSIOPOExpired 
				ON tbl_OPSIOPODetails.Code = tbl_OPSIOPOExpired.OPSIOPODetails 
			INNER JOIN tbl_OPSIOPO 
				ON tbl_OPSIOPODetails.OPSIOPO = tbl_OPSIOPO.Code) A
	GROUP BY Product
	HAVING SUM(Stock)<>0) A
	WHERE tbl_LSProduct.Code=A.Product
END
END
